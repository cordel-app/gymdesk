// #2125 M6b-14: the member's own plan reads take the assignment from `plan_snapshots`:
// `GET /me/membership` (the current plan, the other live plans, the Drafts and the Past list, all
// the tail of one ordering) and `GET /me/billing-event-forecast`, which must pick the same
// assignment. Each owned assignment is its current snapshot; a closed one reads its closed status
// and dates because the settle run (M6b-6/7) wrote them there.
//
// The caller is a superadmin: it acts as the gym's admin to assign and cancel plans through the
// real routes, and impersonates the Member for the `/me` reads.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment, createTestGym, request,
} from './helpers';
import { testAssignmentWrite } from './assignmentFixture';

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
  const { insertId } = await db.query('INSERT INTO centers (gym_id, name, status) VALUES (?, ?, ?)', [gym, 'MPR Center', 'active']);
  centers.set(gym, Number(insertId));
  return gym;
}
async function member(gym = gymId): Promise<number> {
  return Number(must(await auth(request.post('/members'), gym)
    .send({ name: 'Member Plan Reader', email: `mpr-${uniq()}@test.com`, default_center_id: centers.get(gym) }), 'member').body.id);
}
async function plan(gym = gymId): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', 2)`, [gym, `MPR Plan ${uniq()}`]);
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
const cancel = async (um: number) => must(await auth(request.delete(`/user-memberships/${um}`)), 'cancel');
const membership = async (memberId: number, gym = gymId) =>
  must(await asMember(request.get('/me/membership'), memberId, gym), 'me/membership').body;

beforeAll(async () => {
  gymId = await gymWithCenter('Member Plan Readers Gym');
  otherGymId = await gymWithCenter('Member Plan Readers Other Gym');
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('GET /me/membership reads the member\'s plans from plan_snapshots', () => {
  it('is closed to an unauthenticated caller', async () => {
    expect((await request.get('/me/membership').set('x-gym-id', gymId)).status).toBe(401);
  });

  it('names the running plan, and lists a cancelled one under Past with its closed status', async () => {
    const m = await member();
    const runningPlan = await plan();
    const first = await run(m, await plan());
    await cancel(first);
    // The cancellation leaves a later end date when the plan was paid through; end it today's past.
    await testAssignmentWrite('UPDATE user_memberships SET ends_at = UTC_DATE() - INTERVAL 1 DAY WHERE id = ?', [first]);
    await db.query('UPDATE plan_snapshots SET ends_at = UTC_DATE() - INTERVAL 1 DAY WHERE anchor_plan_snapshot_id = ?', [first]);
    // M6b-51c-5: and the assignment's own end date on its anchor, which the sync reads.
    await db.query(
      'UPDATE plan_snapshots SET assignment_ends_at = UTC_DATE() - INTERVAL 1 DAY WHERE anchor_plan_snapshot_id = ? AND anchor_plan_snapshot_id = id',
      [first]);
    const running = await run(m, runningPlan);

    const body = await membership(m);
    expect(body.membership).toMatchObject({ id: running, membership_plan_id: runningPlan });
    expect(body.past_memberships).toEqual([expect.objectContaining({ id: first, lifecycle_status: 'cancelled' })]);
  });

  it('the snapshot is the record: a user_memberships row that disagrees does not move it', async () => {
    const m = await member();
    const um = await run(m, await plan());
    await testAssignmentWrite("UPDATE user_memberships SET status = 'cancelled', ends_at = '2020-01-31' WHERE id = ?", [um]);

    const body = await membership(m);
    expect(body.membership).toMatchObject({ id: um, status: 'active' });
    expect(body.past_memberships).toEqual([]);
  });

  it('lists a Draft assignment beside the plans, never as the member\'s plan', async () => {
    const m = await member();
    const drafted = await createTestDraftAssignment(gymId, m, await plan());
    const body = await membership(m);
    expect(body.membership).toBeNull();
    expect(body.other_memberships).toEqual([expect.objectContaining({ id: drafted, status: 'in_cart' })]);
  });

  it('does not reach another gym\'s assignments', async () => {
    const m = await member(otherGymId);
    await run(m, await plan(otherGymId), otherGymId);
    expect((await membership(m, otherGymId)).membership).not.toBeNull();
    expect((await auth(request.get('/me/membership')).set('x-impersonate-as', `member:${m}`)).status)
      .not.toBe(200);
  });
});

describe('GET /me/billing-event-forecast picks the same assignment', () => {
  it('forecasts the running plan, and nothing for a member whose only plan is a Draft', async () => {
    const m = await member();
    await run(m, await plan());
    const running = must(await asMember(request.get('/me/billing-event-forecast'), m), 'forecast').body;
    expect(running.available).toBe(true);

    const drafted = await member();
    await createTestDraftAssignment(gymId, drafted, await plan());
    const none = must(await asMember(request.get('/me/billing-event-forecast'), drafted), 'forecast').body;
    expect(none.available).toBe(false);
  });
});
