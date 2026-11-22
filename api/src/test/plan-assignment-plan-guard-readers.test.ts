// #2125 M6b-22: the Membership Plan router's own reads of its assignments — the card's
// `member_count`, the Delete and Deactivate guards and the member-limit check — count each
// assignment once, from its current plan snapshot. Each test makes the legacy `user_memberships`
// row unreachable from the gym (moved to another gym) and asserts the plan still sees the
// assignment through its snapshot.
import { TEST_ASSIGNMENTS } from './assignmentReads';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment, createTestGym, createTestMembership, request,
} from './helpers';

let gymId: string;
let otherGymId: string;
let centerId: number;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
const must = (res: any, what: string) => {
  if (res.status >= 300) throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body)}`);
  return res;
};

async function member(): Promise<number> {
  return Number(must(await auth(request.post('/members'))
    .send({ name: 'Plan Guard Reader', email: `pgr-${uniq()}@test.com`, default_center_id: centerId }), 'member').body.id);
}

async function plan(memberLimit = 1): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', ?)`, [gymId, `PGR Plan ${uniq()}`, memberLimit]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, 30, '2020-01-01', 'active')`, [gymId, insertId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return Number(insertId);
}

async function running(planId: number, owner?: number): Promise<number> {
  const um = await createTestDraftAssignment(gymId, owner ?? await member(), planId);
  must(await auth(request.post(`/user-memberships/${um}/activate`)).send({ on_conflict: 'add' }), 'activate');
  return um;
}

/** Makes the legacy row unreachable from the gym, leaving every plan snapshot as it is. */
const moveLegacyRowAway = (um: number) =>
  db.query('UPDATE user_memberships SET gym_id = ? WHERE id = ?', [otherGymId, um]);

beforeAll(async () => {
  gymId = await createTestGym('Plan Guard Readers Gym');
  otherGymId = await createTestGym('Plan Guard Readers Other Gym');
  await createTestMembership(gymId, 'admin');
  ({ insertId: centerId } = await db.query('INSERT INTO centers (gym_id, name, status) VALUES (?, ?, ?)', [gymId, 'PGR Center', 'active']));
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('the Membership Plan card counts its running assignments from plan_snapshots', () => {
  it('counts a running assignment with no legacy row in the gym, and not a Draft', async () => {
    const planId = await plan();
    const um = await running(planId);
    await createTestDraftAssignment(gymId, await member(), planId);
    await moveLegacyRowAway(um);
    const res = must(await auth(request.get(`/membership-plans/${planId}`)), 'get');
    expect(res.body.member_count).toBe(1);
  });
});

describe('Delete and Deactivate refuse a plan with a running assignment', () => {
  it('refuses both with no legacy row in the gym', async () => {
    const planId = await plan();
    const um = await running(planId);
    await moveLegacyRowAway(um);
    expect((await auth(request.post(`/membership-plans/${planId}/archive`))).status).toBe(400);
    expect((await auth(request.delete(`/membership-plans/${planId}`))).status).toBe(400);
  });

  it('allows both once the snapshot says the assignment is over', async () => {
    const planId = await plan();
    const um = await running(planId);
    await db.query(`UPDATE plan_snapshots SET status = 'cancelled' WHERE gym_id = ? AND source_user_membership_id = ?`, [gymId, um]);
    expect((await auth(request.post(`/membership-plans/${planId}/archive`))).status).toBe(200);
    expect((await auth(request.delete(`/membership-plans/${planId}`))).status).toBe(204);
  });
});

describe('the member limit cannot go below a running assignment\'s beneficiaries', () => {
  it('counts the current snapshot\'s beneficiaries with no legacy row in the gym', async () => {
    const planId = await plan(2);
    const owner = await member();
    const partner = await member();
    const um = await running(planId, owner);
    const { rows } = await db.query<{ id: number }>(
      `SELECT id FROM plan_snapshots WHERE gym_id = ? AND source_user_membership_id = ? ORDER BY id DESC LIMIT 1`, [gymId, um]);
    await db.query(`INSERT IGNORE INTO plan_snapshot_beneficiaries (gym_id, plan_snapshot_id, member_id) VALUES (?, ?, ?)`,
      [gymId, rows[0].id, partner]);
    await moveLegacyRowAway(um);
    expect((await auth(request.put(`/membership-plans/${planId}`)).send({ member_limit: '1' })).status).toBe(400);
  });
});

// #2125 M6b-29: "Apply new price to assigned plans" picks its candidates from each assignment's
// current plan snapshot, so an assignment the snapshot states is over is not repriced even while
// its legacy row still reads `active`.
describe('the Plan reprice picks its candidates from plan_snapshots', () => {
  const applyPrice = async (planId: number, price: number) => {
    must(await auth(request.put(`/membership-plans/${planId}/pricing`)).send({ price }), 'pricing');
    return must(await auth(request.post(`/membership-plans/${planId}/pricing/apply-to-assigned-plans`)), 'apply');
  };

  it('reprices a running assignment', async () => {
    const planId = await plan();
    await running(planId);
    const res = await applyPrice(planId, 45);
    expect(res.body.updated).toBe(1);
  });

  it('skips an assignment its current snapshot states is over', async () => {
    const planId = await plan();
    const um = await running(planId);
    await db.query(`UPDATE plan_snapshots SET status = 'cancelled' WHERE gym_id = ? AND source_user_membership_id = ?`, [gymId, um]);
    const { rows: legacy } = await db.query<{ status: string }>(`SELECT status FROM ${TEST_ASSIGNMENTS} um WHERE id = ?`, [um]);
    expect(legacy[0].status).toBe('active');
    const res = await applyPrice(planId, 46);
    expect(res.body.updated).toBe(0);
    expect(res.body.kept_discounted).toBe(0);
  });
});
