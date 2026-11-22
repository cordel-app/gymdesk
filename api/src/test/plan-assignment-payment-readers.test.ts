// #2125 M6b-15: three payment-side readers take the assignment from `plan_snapshots` (its current
// snapshot): the member's own applied Promotions (`GET /me/promotions`), the member's Pay now
// (`POST /me/payment-requests`) and a staff-raised payment request (`POST /payment-requests`).
// The snapshot is the record, so these tests make the legacy row disagree with it and assert the
// answer follows the snapshot.
//
// The caller is a superadmin: it acts as the gym's admin and impersonates the Member for `/me`.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment, createTestGym, request, legacyChildQuery,
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
  const { insertId } = await db.query('INSERT INTO centers (gym_id, name, status) VALUES (?, ?, ?)', [gym, 'PPR Center', 'active']);
  centers.set(gym, Number(insertId));
  return gym;
}
async function member(gym = gymId): Promise<number> {
  return Number(must(await auth(request.post('/members'), gym)
    .send({ name: 'Payment Plan Reader', email: `ppr-${uniq()}@test.com`, default_center_id: centers.get(gym) }), 'member').body.id);
}
async function plan(gym = gymId): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', 2)`, [gym, `PPR Plan ${uniq()}`]);
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
  gymId = await gymWithCenter('Payment Plan Readers Gym');
  otherGymId = await gymWithCenter('Payment Plan Readers Other Gym');
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

/** Close the assignment on its snapshots only, leaving the legacy row active. */
const closeOnSnapshots = (um: number) =>
  db.query("UPDATE plan_snapshots SET status = 'cancelled' WHERE assignment_id = ?", [um]);

describe('POST /payment-requests reads the assignment from plan_snapshots', () => {
  it('is closed to an unauthenticated caller', async () => {
    expect((await request.post('/payment-requests').set('x-gym-id', gymId).send({ user_membership_id: 1 })).status).toBe(401);
  });

  it('refuses an assignment its snapshot says is cancelled, whatever the legacy row says', async () => {
    const m = await member();
    const um = await run(m, await plan());
    await closeOnSnapshots(um);
    const res = await auth(request.post('/payment-requests')).send({ user_membership_id: um });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Membership not found');
  });

  it('does not reach another gym\'s assignment', async () => {
    const m = await member(otherGymId);
    const um = await run(m, await plan(otherGymId), otherGymId);
    const res = await auth(request.post('/payment-requests')).send({ user_membership_id: um });
    expect(res.status).toBe(404);
  });
});

describe('POST /me/payment-requests (Pay now) reads the member\'s plans from plan_snapshots', () => {
  it('finds no plan to pay when the only one is cancelled on its snapshot', async () => {
    const m = await member();
    const um = await run(m, await plan());
    await closeOnSnapshots(um);
    const res = await asMember(request.post('/me/payment-requests'), m).send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('No active membership found');
  });
});

describe('GET /me/promotions reads the member\'s plans from plan_snapshots', () => {
  async function applied(um: number): Promise<number> {
    const { insertId } = await db.query(
      `INSERT INTO promotions (gym_id, name, lifecycle_status, starts_at, ends_at)
       VALUES (?, ?, 'active', '2020-01-01', '2099-12-31')`, [gymId, `PPR Promo ${uniq()}`]);
    // #3026: the application is the plan snapshot's own row (the fixture helper writes it there).
    await legacyChildQuery(
      `INSERT INTO user_membership_promotions (gym_id, user_membership_id, promotion_id, status, applied_at)
       VALUES (?, ?, ?, 'applied', UTC_TIMESTAMP())`, [gymId, um, insertId]);
    return Number(insertId);
  }

  it('lists a Promotion applied to a running plan, and none once the snapshot closes it', async () => {
    const m = await member();
    const um = await run(m, await plan());
    const promo = await applied(um);
    const before = must(await asMember(request.get('/me/promotions'), m), 'promotions').body;
    expect(before.map((p: any) => p.id)).toEqual([promo]);

    await closeOnSnapshots(um);
    const after = must(await asMember(request.get('/me/promotions'), m), 'promotions').body;
    expect(after).toEqual([]);
  });
});
