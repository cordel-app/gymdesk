// #2125 M6b-8: three more readers take the assignment from `plan_snapshots`: the Financials
// dashboard's assigned-plan count, the plan names Home shows beside a Member, and the statuses the
// card-removal check asks. The assignment is its current snapshot (the one the owner's Active
// Product Set links), so a plan counts once however many Product Sets link a snapshot of it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment, createTestGym, createTestMembership, request,
  seedScheduledEvent,
} from './helpers';

let gymId: string;
let otherGymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const auth = (r: any, gym = gymId) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);
const must = (res: any, what: string) => {
  if (res.status >= 300) throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body)}`);
  return res;
};

/** A gym with an admin and one center (a Member needs a default center). */
async function gymWithCenter(name: string): Promise<{ gym: string; center: number }> {
  const gym = await createTestGym(name);
  await createTestMembership(gym, 'admin');
  const { insertId } = await db.query('INSERT INTO centers (gym_id, name, status) VALUES (?, ?, ?)', [gym, 'PDR Center', 'active']);
  return { gym, center: Number(insertId) };
}
const centers = new Map<string, number>();
async function member(gym = gymId, name = 'Dashboard Reader'): Promise<number> {
  return Number(must(await auth(request.post('/members'), gym)
    .send({ name, email: `pdr-${uniq()}@test.com`, default_center_id: centers.get(gym) }), 'member').body.id);
}
/** A monthly plan at 10.00, named so a test can find it. */
async function plan(gym = gymId, name = `PDR Plan ${uniq()}`): Promise<{ id: number; name: string }> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', 2)`, [gym, name]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, 10, '2020-01-01', 'active')`, [gym, insertId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gym, insertId]);
  return { id: Number(insertId), name };
}
const activate = async (um: number, gym = gymId) =>
  must(await auth(request.post(`/user-memberships/${um}/activate`), gym).send({ on_conflict: 'add' }), 'activate');
/** Assigns `planId` to the Member and makes it their running plan (beside any they already hold). */
async function run(memberId: number, planId: number, gym = gymId): Promise<number> {
  const um = await createTestDraftAssignment(gym, memberId, planId);
  await activate(um, gym);
  return um;
}
const setStatus = async (um: number, status: 'paused' | 'active', gym = gymId) =>
  must(await auth(request.put(`/user-memberships/${um}`), gym).send({ status }), status);
const cancel = async (um: number, gym = gymId) => must(await auth(request.delete(`/user-memberships/${um}`), gym), 'cancel');
const draftOf = async (memberId: number, gym = gymId): Promise<number> =>
  Number(must(await auth(request.post('/product-sets/draft'), gym).send({ member_id: memberId }), 'draft').body.id);

const CARDS = '/financials/dashboard/membership-plans';
/** The assigned-plan count the Financials dashboard shows for a plan (`null`: the plan has no card). */
async function assigned(planId: number, gym = gymId): Promise<number | null> {
  const res = must(await auth(request.get(CARDS), gym), 'cards');
  const card = (res.body as any[]).find((c) => Number(c.id) === planId);
  return card ? Number(card.assigned_members) : null;
}

beforeAll(async () => {
  const a = await gymWithCenter('Assignment Dashboard Readers Gym');
  const b = await gymWithCenter('Assignment Dashboard Readers Other Gym');
  gymId = a.gym; otherGymId = b.gym;
  centers.set(a.gym, a.center); centers.set(b.gym, b.center);
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('the Financials dashboard counts assigned plans from plan_snapshots', () => {
  it('is closed to an unauthenticated caller, and another gym does not see the plan', async () => {
    const p = await plan();
    await run(await member(), p.id);
    expect((await request.get(CARDS).set('x-gym-id', gymId)).status).toBe(401);
    expect(await assigned(p.id)).toBe(1);
    expect(await assigned(p.id, otherGymId)).toBeNull();
  });

  it('counts each assignment, including the same plan held twice by one Member', async () => {
    const p = await plan();
    const m = await member();
    await run(m, p.id);
    expect(await assigned(p.id)).toBe(1);
    await run(m, p.id);
    expect(await assigned(p.id)).toBe(2);
    await run(await member(), p.id);
    expect(await assigned(p.id)).toBe(3);
  });

  it('counts a paused plan; not a Draft one nor a cancelled one', async () => {
    const p = await plan();
    await createTestDraftAssignment(gymId, await member(), p.id);
    expect(await assigned(p.id)).toBe(0);

    const um = await run(await member(), p.id);
    expect(await assigned(p.id)).toBe(1);
    await setStatus(um, 'paused');
    expect(await assigned(p.id)).toBe(1);
    await setStatus(um, 'active');
    await cancel(um);
    expect(await assigned(p.id)).toBe(0);
  });

  it('counts a plan once while a Draft Product Set links the same snapshot', async () => {
    const p = await plan();
    const m = await member();
    await run(m, p.id);
    await draftOf(m);
    expect(await assigned(p.id)).toBe(1);
  });

  it('does not count the plan of a soft-deleted Member', async () => {
    const p = await plan();
    const m = await member();
    await run(m, p.id);
    await db.query('UPDATE members SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [m]);
    expect(await assigned(p.id)).toBe(0);
  });

  it('the snapshot is the record: a user_memberships row that disagrees does not move the count', async () => {
    const p = await plan();
    const um = await run(await member(), p.id);
    await db.query("UPDATE user_memberships SET status = 'cancelled' WHERE id = ?", [um]);
    expect(await assigned(p.id)).toBe(1);
  });
});

describe('Home names a Member\'s running plans from plan_snapshots', () => {
  /** The plan names Home's Latest Members shows for a Member of `gym`. */
  async function planNames(gym: string, memberId: number): Promise<string | null | undefined> {
    const res = must(await auth(request.get('/dashboard/home'), gym), 'home');
    const row = (res.body.latest_members as any[]).find((r) => Number(r.id) === memberId);
    return row ? row.plan_name : undefined;
  }

  it('lists the running plans newest first, and neither a Draft nor a cancelled one', async () => {
    // A gym of its own: Latest Members shows the five newest.
    const { gym, center } = await gymWithCenter('Assignment Dashboard Readers Home Gym');
    centers.set(gym, center);
    const m = await member(gym, 'PDR Home Member');
    expect(await planNames(gym, m)).toBeNull();

    const first = await plan(gym);
    const second = await plan(gym);
    const draft = await plan(gym);
    await createTestDraftAssignment(gym, await member(gym, 'PDR Draft Only'), draft.id);
    const umFirst = await run(m, first.id, gym);
    expect(await planNames(gym, m)).toBe(first.name);
    await run(m, second.id, gym);
    expect(await planNames(gym, m)).toBe(`${second.name}, ${first.name}`);

    // A Draft Product Set that links the same snapshots names each plan once.
    await draftOf(m, gym);
    expect(await planNames(gym, m)).toBe(`${second.name}, ${first.name}`);
    must(await auth(request.delete(`/product-sets/${await draftOf(m, gym)}`), gym), 'discard draft');

    await setStatus(umFirst, 'paused', gym);
    expect(await planNames(gym, m)).toBe(`${second.name}, ${first.name}`);
    await setStatus(umFirst, 'active', gym);
    await cancel(umFirst, gym);
    expect(await planNames(gym, m)).toBe(second.name);

    const draftOnly = must(await auth(request.get('/dashboard/home'), gym), 'home').body.latest_members
      .find((r: any) => r.name === 'PDR Draft Only');
    expect(draftOnly.plan_name).toBeNull();
  });
});

describe('the card-removal check reads the plan\'s status from plan_snapshots', () => {
  const card = (memberId: number, gym = gymId) => auth(request.get(`/payment-methods?member_id=${memberId}`), gym);
  const storeCard = (memberId: number) => db.query(
    `INSERT INTO payment_methods (gym_id, member_id, provider, payment_token, sequence_id, card_last4, card_brand)
     VALUES (?, ?, 'monei', ?, 'seq_pdr', '4242', 'visa')`, [gymId, memberId, `tok_${uniq()}`]);

  /** A running plan with a charge scheduled a month from now (the fixture plan freezes no fee). */
  async function runBilled(memberId: number): Promise<number> {
    const um = await run(memberId, (await plan()).id);
    await seedScheduledEvent(gymId, memberId, um, 'DATE_ADD(CURDATE(), INTERVAL 1 MONTH)');
    return um;
  }

  it('a Member of another gym is not found', async () => {
    const m = await member();
    expect((await card(m, otherGymId)).status).toBe(404);
  });

  it('keeps the card of a Member whose running plan has charges scheduled, whatever the legacy row says', async () => {
    const m = await member();
    await storeCard(m);
    expect(must(await card(m), 'card').body.member_can_remove).toBe(true);

    const um = await runBilled(m);
    const blocked = must(await card(m), 'card').body;
    expect(blocked.member_can_remove).toBe(false);
    expect(blocked.removal_blocked_reason).toBe('billable_membership');

    await db.query("UPDATE user_memberships SET status = 'cancelled' WHERE id = ?", [um]);
    expect(must(await card(m), 'card').body.member_can_remove).toBe(false);
  });

  it('lets the card go once the plan is cancelled', async () => {
    const m = await member();
    await storeCard(m);
    const um = await runBilled(m);
    expect(must(await card(m), 'card').body.member_can_remove).toBe(false);
    await cancel(um);
    expect(must(await card(m), 'card').body.member_can_remove).toBe(true);
  });
});
