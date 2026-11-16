// #2125 M6b-27: the ProductSet bridge takes two facts about an assignment from its current plan
// snapshot instead of the `user_memberships` row: whether a configuration edit of a running plan may
// become a new version (`reconfigureProjected()`'s closed-assignment check) and the start date the
// cancellation end date is clamped to (`cancellationEndFor()`, behind the cancellation preview and
// the cancellation itself). Each test makes the snapshot and the legacy row disagree and asserts
// the route follows the snapshot.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment, createTestGym, createTestMembership, request,
} from './helpers';

let gymId: string;
let centerId: number;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
const must = (res: any, what: string) => {
  if (res.status >= 300) throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body)}`);
  return res;
};

async function running(): Promise<number> {
  const memberId = Number(must(await auth(request.post('/members'))
    .send({ name: 'Bridge Reader', email: `bdr-${uniq()}@test.com`, default_center_id: centerId }), 'member').body.id);
  const { insertId: planId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', 1)`, [gymId, `BDR Plan ${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, 30, '2020-01-01', 'active')`, [gymId, planId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, planId]);
  const um = await createTestDraftAssignment(gymId, memberId, Number(planId));
  must(await auth(request.post(`/user-memberships/${um}/activate`)).send({ on_conflict: 'add' }), 'activate');
  return um;
}

const setLegacy = (um: number, column: string, value: string) =>
  db.query(`UPDATE user_memberships SET ${column} = ? WHERE id = ?`, [value, um]);
const setSnapshots = (um: number, column: string, value: string) =>
  db.query(`UPDATE plan_snapshots SET ${column} = ? WHERE gym_id = ? AND source_user_membership_id = ?`, [value, gymId, um]);
/** The version the assignment is linked to (a new version takes the link over from its predecessor). */
const linkedVersion = async (um: number): Promise<number> => {
  const { rows } = await db.query<any>(
    'SELECT MAX(id) AS id FROM product_sets WHERE gym_id = ? AND user_membership_id = ?', [gymId, um]);
  return Number(rows[0].id);
};
const feeBenefit = (um: number) =>
  auth(request.put(`/user-memberships/${um}/fee-benefit`)).send({ action: 'percentage_discount', value: 10 });

beforeAll(async () => {
  gymId = await createTestGym('Bridge Readers Gym');
  await createTestMembership(gymId, 'admin');
  ({ insertId: centerId } = await db.query('INSERT INTO centers (gym_id, name, status) VALUES (?, ?, ?)', [gymId, 'BDR Center', 'active']));
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('a configuration edit of a running plan asks the plan snapshot whether it is closed', () => {
  it('edits as a new version when the snapshot is active, even when the legacy row says cancelled', async () => {
    const um = await running();
    const before = await linkedVersion(um);
    await setLegacy(um, 'status', 'cancelled');
    const res = await feeBenefit(um);
    expect(res.status).toBe(200);
    expect(await linkedVersion(um)).toBeGreaterThan(before);
  });

  it('refuses the edit when the snapshot says cancelled, even when the legacy row says active', async () => {
    const um = await running();
    const before = await linkedVersion(um);
    await setSnapshots(um, 'status', 'cancelled');
    const res = await feeBenefit(um);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cancelled/);
    expect(await linkedVersion(um)).toBe(before);
  });
});

describe('the cancellation end date is clamped to the plan snapshot\'s start date', () => {
  it('reports the snapshot\'s start when nothing was paid and the plan starts later', async () => {
    const um = await running();
    await setSnapshots(um, 'starts_at', '2099-01-01');
    await setLegacy(um, 'starts_at', '2020-01-01');
    const res = must(await auth(request.get(`/user-memberships/${um}/cancellation-preview`)), 'preview');
    expect(res.body.ends_on).toBe('2099-01-01');
  });
});
