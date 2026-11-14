// #2125 M6b-10: five readers that are handed an assignment's id and need only what never changes
// over its life (its owner, its Membership Plan) take it from `plan_snapshots`: the manual append
// of a Billing Event (`POST /payments`, `POST /billing-events`), the hosted payment page's billing
// interval, the plan name beside a Billing Event's transactions, and the Audit Log's name for a
// Membership. They answer the same whatever the plan's status is.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { resolveEntityName } from '../infra/audit-registry';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment, createTestGym, createTestMembership, request,
} from './helpers';

let gymId: string;
let otherGymId: string;
let chargeTypeId: number;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const auth = (r: any, gym = gymId) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);
const must = (res: any, what: string) => {
  if (res.status >= 300) throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body)}`);
  return res;
};

async function member(name = 'Id Reader'): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, name, `pair-${uniq()}@test.com`]);
  return Number(insertId);
}

/** A free plan billed every `interval` months. */
async function plan(name: string, interval = 1): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status)
     VALUES (?, ?, 'active', 'public')`, [gymId, name]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, ?, 'month')`, [gymId, insertId, interval]);
  return Number(insertId);
}

/** Assigns the plan to the Member and makes it their running plan. */
async function run(memberId: number, planId: number): Promise<number> {
  const um = await createTestDraftAssignment(gymId, memberId, planId);
  must(await auth(request.post(`/user-memberships/${um}/activate`)).send({ on_conflict: 'add' }), 'activate');
  return um;
}
const cancel = async (um: number) => must(await auth(request.delete(`/user-memberships/${um}`)), 'cancel');
const pause = async (um: number) => must(await auth(request.put(`/user-memberships/${um}`)).send({ status: 'paused' }), 'pause');

const append = (path: '/payments' | '/billing-events', body: object, gym = gymId) =>
  auth(request.post(path), gym).send({ event_type: 'payment_recorded', charge_type_id: chargeTypeId, amount: 20, ...body });

async function pendingRequest(um: number, memberId: number, extra: { token?: string; eventId?: number } = {}): Promise<void> {
  await db.query(
    `INSERT INTO payment_requests
       (gym_id, user_membership_id, member_id, billing_event_id, amount, currency, charge_type_id,
        status, provider, provider_order, provider_ref, page_token, page_token_expires, source)
     VALUES (?, ?, ?, ?, '20.00', 'EUR', ?, 'pending', 'monei', UUID(), 'pay_ref', ?,
             DATE_ADD(UTC_TIMESTAMP(), INTERVAL 10 MINUTE), 'admin')`,
    [gymId, um, memberId, extra.eventId ?? null, chargeTypeId, extra.token ?? null]);
}

beforeAll(async () => {
  gymId = await createTestGym('Assignment Id Readers Gym');
  otherGymId = await createTestGym('Assignment Id Readers Other Gym');
  await createTestMembership(gymId, 'admin');
  await createTestMembership(otherGymId, 'admin');
  const { rows } = await db.query<{ id: number }>("SELECT id FROM charge_types WHERE code = 'membership_fee'");
  chargeTypeId = rows[0].id;
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe.each(['/payments', '/billing-events'] as const)('POST %s names an assignment by its id', (path) => {
  it('records the event for the assignment\'s owner when only the assignment is given', async () => {
    const m = await member();
    const um = await run(m, await plan(`PAIR ${uniq()}`));
    const res = await append(path, { user_membership_id: um });
    expect(res.status).toBe(201);
    expect(res.body.member_id).toBe(m);
  });

  it('refuses a member who is not the assignment\'s owner, running, paused or cancelled', async () => {
    const owner = await member();
    const stranger = await member();
    const um = await run(owner, await plan(`PAIR ${uniq()}`));
    const mismatch = async () => {
      const res = await append(path, { user_membership_id: um, member_id: stranger });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('member_id does not match the membership');
    };
    await mismatch();
    await pause(um);
    await mismatch();
    await cancel(um);
    await mismatch();
  });

  it('answers 404 for an unknown assignment and for another gym\'s', async () => {
    const m = await member();
    const um = await run(m, await plan(`PAIR ${uniq()}`));
    expect((await append(path, { user_membership_id: 999999999 })).status).toBe(404);
    const other = await append(path, { user_membership_id: um }, otherGymId);
    expect(other.status).toBe(404);
    expect(other.body.error).toBe('Membership not found');
  });
});

describe('the hosted payment page reads the plan\'s billing interval through the assignment', () => {
  it('reports the interval of the plan the request\'s assignment is of, also once it is paused', async () => {
    const m = await member();
    const um = await run(m, await plan(`PAIR ${uniq()}`, 3));
    const first = `tok-${uniq()}`;
    await pendingRequest(um, m, { token: first });
    const res = await request.get(`/payment-page/token/${first}`);
    expect(res.status).toBe(200);
    expect(res.body.billingInterval).toBe('3 month');

    await pause(um);
    const second = `tok-${uniq()}`;
    await pendingRequest(um, m, { token: second });
    expect((await request.get(`/payment-page/token/${second}`)).body.billingInterval).toBe('3 month');
  });

  it('a Member holding two plans gets each request\'s own plan', async () => {
    const m = await member();
    const monthly = await run(m, await plan(`PAIR ${uniq()}`, 1));
    const quarterly = await run(m, await plan(`PAIR ${uniq()}`, 3));
    const a = `tok-${uniq()}`;
    const b = `tok-${uniq()}`;
    await pendingRequest(monthly, m, { token: a });
    await pendingRequest(quarterly, m, { token: b });
    expect((await request.get(`/payment-page/token/${a}`)).body.billingInterval).toBe('1 month');
    expect((await request.get(`/payment-page/token/${b}`)).body.billingInterval).toBe('3 month');
  });
});

describe('a Billing Event\'s transactions name the plan of the request\'s assignment', () => {
  it('lists one row per request with the plan name, also after the plan is cancelled', async () => {
    const m = await member();
    const planName = `PAIR Named ${uniq()}`;
    const um = await run(m, await plan(planName));
    const eventId = Number(must(await append('/payments', { user_membership_id: um }), 'append').body.id);
    await pendingRequest(um, m, { eventId });

    const read = () => auth(request.get(`/payments/billing-events/${eventId}/transactions`));
    const before = must(await read(), 'transactions');
    expect(before.body.items).toHaveLength(1);
    expect(before.body.items[0].plan_name).toBe(planName);

    await cancel(um);
    const after = must(await read(), 'transactions');
    expect(after.body.items).toHaveLength(1);
    expect(after.body.items[0].plan_name).toBe(planName);
  });
});

describe('the Audit Log names a Membership from its plan snapshot', () => {
  it('reads "<Member> — <Plan>" for a Draft, a running and a cancelled assignment', async () => {
    const m = await member('Audit Named Member');
    const planName = `PAIR Audit ${uniq()}`;
    const um = await createTestDraftAssignment(gymId, m, await plan(planName));
    const name = () => resolveEntityName('user_membership', String(um), gymId);
    expect(await name()).toBe(`Audit Named Member — ${planName}`);
    must(await auth(request.post(`/user-memberships/${um}/activate`)).send({ on_conflict: 'add' }), 'activate');
    expect(await name()).toBe(`Audit Named Member — ${planName}`);
    await cancel(um);
    expect(await name()).toBe(`Audit Named Member — ${planName}`);
    expect(await resolveEntityName('user_membership', '999999999', gymId)).toBeNull();
  });
});
