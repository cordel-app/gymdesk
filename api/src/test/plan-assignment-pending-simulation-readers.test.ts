// #2125 M6b-17: two more readers take the assignment from `plan_snapshots`: `GET /me/membership`'s
// plan awaiting its first payment (`pending_membership`), and the Billing Simulation's loader
// (`loadSimulationAssignments()`), which also feeds the Assigned Plan card's forecast and line prices.
// Each test makes the snapshot and the legacy row disagree and asserts the snapshot wins.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
  const { insertId } = await db.query('INSERT INTO centers (gym_id, name, status) VALUES (?, ?, ?)', [gym, 'PSR Center', 'active']);
  centers.set(gym, Number(insertId));
  return gym;
}
async function member(gym = gymId): Promise<number> {
  return Number(must(await auth(request.post('/members'), gym)
    .send({ name: 'Pending Sim Reader', email: `psr-${uniq()}@test.com`, default_center_id: centers.get(gym) }), 'member').body.id);
}
async function plan(gym = gymId): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', 2)`, [gym, `PSR Plan ${uniq()}`]);
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
const membership = async (memberId: number, gym = gymId) =>
  must(await asMember(request.get('/me/membership'), memberId, gym), 'me/membership').body;

beforeAll(async () => {
  gymId = await gymWithCenter('Pending Sim Readers Gym');
  otherGymId = await gymWithCenter('Pending Sim Readers Other Gym');
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

const simulation = async (memberId: number, gym = gymId) =>
  must(await auth(request.get(`/user-memberships/member/${memberId}/billing-simulation`), gym), 'simulation').body;

describe('GET /me/membership reads the plan awaiting payment from plan_snapshots', () => {
  it('reports the assignment whose current snapshot is pending payment, whatever the legacy row says', async () => {
    const m = await member();
    const planId = await plan();
    const um = await run(m, planId);
    await db.query("UPDATE plan_snapshots SET status = 'pending_payment' WHERE source_user_membership_id = ?", [um]);

    const body = await membership(m);
    expect(body.pending_membership).toMatchObject({ id: um, billing_interval: 1, billing_unit: 'month' });
  });

  it('a legacy row that says pending payment does not make the running plan one', async () => {
    const m = await member();
    const um = await run(m, await plan());
    await db.query("UPDATE user_memberships SET status = 'pending_payment' WHERE id = ?", [um]);

    expect((await membership(m)).pending_membership).toBeNull();
  });
});

describe('the Billing Simulation reads its assignments from plan_snapshots', () => {
  it('is closed to an unauthenticated caller', async () => {
    const m = await member();
    expect((await request.get(`/user-memberships/member/${m}/billing-simulation`).set('x-gym-id', gymId)).status).toBe(401);
  });

  it('simulates the plan the snapshot says is running, and not one only the legacy row calls running', async () => {
    const m = await member();
    const um = await run(m, await plan());
    await db.query("UPDATE user_memberships SET status = 'cancelled' WHERE id = ?", [um]);
    expect((await simulation(m)).available).toBe(true);

    const closed = await member();
    const closedUm = await run(closed, await plan());
    await db.query("UPDATE plan_snapshots SET status = 'cancelled' WHERE source_user_membership_id = ?", [closedUm]);
    expect((await simulation(closed)).available).toBe(false);
  });

  it('does not reach another gym\'s member', async () => {
    const m = await member(otherGymId);
    await run(m, await plan(otherGymId), otherGymId);
    expect((await auth(request.get(`/user-memberships/member/${m}/billing-simulation`))).status).toBe(404);
  });
});
