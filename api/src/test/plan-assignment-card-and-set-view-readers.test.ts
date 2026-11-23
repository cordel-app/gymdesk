// #2125 M6b-18: two more readers take the assignment from `plan_snapshots`: the assignment a card
// replacement is recorded against (`resolveCardUpdateMembership()`, staff and member routes), and
// the plan status the Members App's Product Set view reports (`loadMemberProductSetView()`).
// Each test makes the snapshot and the legacy row disagree and asserts the snapshot wins.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment, createTestGym, request,
} from './helpers';
import { testAssignmentWrite } from './assignmentFixture';

const createCardVerificationRequest = vi.fn().mockResolvedValue({ providerOrderId: 'monei-verif-m6b18' });
vi.mock('../payments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../payments')>()),
  getPaymentProvider: () => ({ createCardVerificationRequest }),
}));

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
  const { insertId } = await db.query('INSERT INTO centers (gym_id, name, status) VALUES (?, ?, ?)', [gym, 'CRD Center', 'active']);
  centers.set(gym, Number(insertId));
  return gym;
}
async function member(gym = gymId): Promise<number> {
  return Number(must(await auth(request.post('/members'), gym)
    .send({ name: 'Card Reader', email: `crd-${uniq()}@test.com`, default_center_id: centers.get(gym) }), 'member').body.id);
}
async function plan(gym = gymId): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', 2)`, [gym, `CRD Plan ${uniq()}`]);
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
  gymId = await gymWithCenter('Card Readers Gym');
  otherGymId = await gymWithCenter('Card Readers Other Gym');
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

const cardRequestAssignment = async (memberId: number, gym = gymId) => {
  const res = must(await auth(request.post('/payment-methods/replace-requests'), gym).send({ member_id: memberId }), 'replace-request');
  const { rows } = await db.query<{ user_membership_id: number }>('SELECT anchor_plan_snapshot_id AS user_membership_id FROM payment_requests WHERE id = ?', [res.body.id]);
  return Number(rows[0].user_membership_id);
};

describe('a card replacement is recorded against the assignment plan_snapshots says is running', () => {
  it('is closed to an unauthenticated caller', async () => {
    const m = await member();
    expect((await request.post('/payment-methods/replace-requests').set('x-gym-id', gymId).send({ member_id: m })).status).toBe(401);
  });

  it('prefers the plan whose snapshot is active over one only the legacy row calls active', async () => {
    const m = await member();
    const running = await run(m, await plan());
    const other = await run(m, await plan());
    // The snapshot says the second plan was cancelled; its legacy row still says active.
    await db.query("UPDATE plan_snapshots SET status = 'cancelled' WHERE anchor_plan_snapshot_id = ?", [other]);
    await testAssignmentWrite("UPDATE user_memberships SET status = 'cancelled' WHERE id = ?", [running], { mirror: false });
    expect(await cardRequestAssignment(m)).toBe(running);
  });

  it('answers 400 for a member with no assignment, and 404 for another gym\'s member', async () => {
    const m = await member();
    expect((await auth(request.post('/payment-methods/replace-requests')).send({ member_id: m })).status).toBe(400);
    const foreign = await member(otherGymId);
    await run(foreign, await plan(otherGymId), otherGymId);
    expect((await auth(request.post('/payment-methods/replace-requests')).send({ member_id: foreign })).status).toBe(404);
  });
});

describe('the Members App Product Set view reports the plan status plan_snapshots holds', () => {
  it('reports the snapshot\'s status, whatever the legacy row says', async () => {
    const m = await member();
    const um = await run(m, await plan());
    await db.query("UPDATE plan_snapshots SET status = 'paused' WHERE anchor_plan_snapshot_id = ?", [um]);
    await testAssignmentWrite("UPDATE user_memberships SET status = 'active' WHERE id = ?", [um]);
    const { rows } = await db.query<{ id: number }>(
      "SELECT id FROM product_sets WHERE gym_id = ? AND owner_member_id = ? AND status = 'active'", [gymId, m]);
    const view = must(await asMember(request.get(`/me/product-sets/${rows[0].id}`), m), 'me/product-sets/:id').body;
    const plans = (view.plans ?? view.view?.plans) as any[];
    expect(plans).toHaveLength(1);
    expect(plans[0].status).toBe('paused');
  });
});
