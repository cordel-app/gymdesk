// #2125 M6b-16: the Billing Event readers take an event's assignment plan and status from
// `plan_snapshots` (its current snapshot): the Billing Events list and detail (`GET
// /payments/billing-events`, `GET /payments/billing-events/:id`) and the member's own payment
// history (`GET /me/payment-requests`). The assignment's legacy id is still reported as is.
// The snapshot is the record, so these tests make the legacy row disagree with it and assert the
// answer follows the snapshot.
//
// The caller is a superadmin: it acts as the gym's admin and impersonates the Member for `/me`.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { productSetOfLegacyAssignmentSql } from '../domain/planAssignments';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment, createTestGym, request,
} from './helpers';

vi.mock('@clerk/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/backend')>();
  return {
    ...actual,
    verifyToken: vi.fn().mockResolvedValue({ sub: 'test-user-id' }),
    createClerkClient: vi.fn(() => ({
      users: {
        getUser: vi.fn().mockResolvedValue({
          publicMetadata: { platform_role: 'superadmin' }, fullName: 'Super Admin', firstName: 'Super', lastName: 'Admin',
        }),
        getUserList: vi.fn().mockResolvedValue({ data: [], totalCount: 0 }),
      },
      invitations: { createInvitation: vi.fn(), revokeInvitation: vi.fn() },
      emailAddresses: { getEmailAddress: vi.fn().mockResolvedValue({ emailAddress: 'test@example.com' }) },
    })),
  };
});

let gymId: string;
let otherGymId: string;
const centers = new Map<string, number>();
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const auth = (r: any, gym = gymId) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);
const asMember = (r: any, memberId: number, gym = gymId) => auth(r, gym).set('x-impersonate-as', `member:${memberId}`);
const must = (res: any, what: string) => {
  if (res.status >= 300) throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body)}`);
  return res;
};

async function gymWithCenter(name: string): Promise<string> {
  const gym = await createTestGym(name);
  const { insertId } = await db.query('INSERT INTO centers (gym_id, name, status) VALUES (?, ?, ?)', [gym, 'BER Center', 'active']);
  centers.set(gym, Number(insertId));
  return gym;
}
async function member(gym = gymId): Promise<number> {
  return Number(must(await auth(request.post('/members'), gym)
    .send({ name: 'Billing Event Reader', email: `ber-${uniq()}@test.com`, default_center_id: centers.get(gym) }), 'member').body.id);
}
async function plan(gym = gymId): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', 2)`, [gym, `BER Plan ${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, 10, '2020-01-01', 'active')`, [gym, insertId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gym, insertId]);
  return Number(insertId);
}
async function run(memberId: number, planId: number, gym = gymId): Promise<number> {
  const um = await createTestDraftAssignment(gym, memberId, planId);
  must(await auth(request.post(`/user-memberships/${um}/activate`), gym).send({ on_conflict: 'add' }), 'activate');
  return um;
}

beforeAll(async () => {
  gymId = await gymWithCenter('Billing Event Readers Gym');
  otherGymId = await gymWithCenter('Billing Event Readers Other Gym');
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

/** Close the assignment on its snapshots only, leaving the legacy row active. */
const closeOnSnapshots = (um: number) =>
  db.query("UPDATE plan_snapshots SET status = 'cancelled' WHERE assignment_id = ?", [um]);


/** A plan with a 4-week cadence, to tell apart from `plan()`'s monthly one. */
async function fourWeekPlan(): Promise<number> {
  const id = await plan();
  await db.query("UPDATE billing_policies SET recurring_billing_interval = 4, recurring_billing_unit = 'week' WHERE membership_plan_id = ?", [id]);
  return id;
}
const planName = async (id: number) =>
  ((await db.query<any>('SELECT name FROM membership_plans WHERE id = ?', [id])).rows[0].name as string);
/** A future scheduled obligation on the assignment's Active Product Set. */
async function eventOf(um: number, gym = gymId): Promise<number> {
  const { rows } = await db.query<any>(
    `SELECT id, owner_member_id FROM product_sets WHERE ${productSetOfLegacyAssignmentSql('?', 'product_sets')} AND status = 'active'`, [um]);
  const { insertId } = await db.query(
    `INSERT INTO billing_events (gym_id, member_id, event_type, source, amount, product_set_id, billing_date, is_scheduled)
     VALUES (?, ?, 'charge_created', 'system', '10.00', ?, DATE_ADD(CURDATE(), INTERVAL 10 DAY), 1)`,
    [gym, rows[0].owner_member_id, rows[0].id]);
  return Number(insertId);
}
const detail = async (id: number, gym = gymId) =>
  auth(request.get(`/payments/billing-events/${id}`), gym);
const listRow = async (memberId: number, id: number) =>
  must(await auth(request.get(`/payments/billing-events?member_id=${memberId}`)), 'list').body.items
    .find((r: any) => r.id === id);
/** Move the assignment onto another plan, or close it, on its snapshots only. */
const snapshotPlan = (um: number, planId: number) =>
  db.query('UPDATE plan_snapshots SET membership_plan_id = ? WHERE assignment_id = ?', [planId, um]);

describe('the Billing Events list and detail read the assignment from plan_snapshots', () => {
  it('is closed to an unauthenticated caller', async () => {
    expect((await request.get('/payments/billing-events/1').set('x-gym-id', gymId)).status).toBe(401);
  });

  it('reports the legacy assignment id and the plan its snapshot names', async () => {
    const m = await member();
    const um = await run(m, await plan());
    const ev = await eventOf(um);
    const other = await plan();
    await snapshotPlan(um, other);

    const d = must(await detail(ev), 'detail').body;
    expect(Number(d.user_membership_id)).toBe(um);
    expect(d.plan_name).toBe(await planName(other));

    const row = await listRow(m, ev);
    expect(Number(row.user_membership_id)).toBe(um);
    expect(row.plan_name).toBe(await planName(other));
  });

  it('reports no next payment once the snapshot closes the plan, whatever the legacy row says', async () => {
    const m = await member();
    const um = await run(m, await plan());
    const ev = await eventOf(um);
    expect(must(await detail(ev), 'detail').body.next_payment_date).not.toBeNull();

    await closeOnSnapshots(um);
    expect(must(await detail(ev), 'detail').body.next_payment_date).toBeNull();
    expect((await listRow(m, ev)).next_payment_date).toBeNull();
  });

  it('does not reach another gym\'s Billing Event', async () => {
    const m = await member(otherGymId);
    const um = await run(m, await plan(otherGymId), otherGymId);
    expect((await detail(await eventOf(um, otherGymId))).status).toBe(404);
  });
});

describe('GET /me/payment-requests reads the plan from plan_snapshots', () => {
  it('reports the cadence of the plan the assignment\'s snapshot names', async () => {
    const m = await member();
    const um = await run(m, await plan());
    await db.query(
      `INSERT INTO payment_requests
         (gym_id, member_id, anchor_plan_snapshot_id, amount, currency, status, provider, source, attempt, method, created_at)
       VALUES (?, ?, ?, '10.00', 'EUR', 'completed', 'monei', 'customer', 1, 'provider', UTC_TIMESTAMP())`,
      [gymId, m, um]);
    const before = must(await asMember(request.get('/me/payment-requests'), m), 'history').body;
    expect(before.map((r: any) => [Number(r.user_membership_id), r.billing_unit])).toEqual([[um, 'month']]);

    await snapshotPlan(um, await fourWeekPlan());
    const after = must(await asMember(request.get('/me/payment-requests'), m), 'history').body;
    expect(after.map((r: any) => [Number(r.billing_interval), r.billing_unit])).toEqual([[4, 'week']]);
  });
});
