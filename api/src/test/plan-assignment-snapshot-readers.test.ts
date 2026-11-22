// #2125 M6b-21: the Assigned Plan snapshot's billing read (`loadAssignedPlanSnapshot()`) and the
// engine's plan-line loader (`loadPlanBenefitsForSimulation()`) take the assignment from its current
// plan snapshot. Each test makes the legacy `user_memberships` row unreachable from the gym (moved
// to another gym) and asserts the reads still answer from the snapshot.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment, createTestGym, createTestMembership, request,
} from './helpers';
import { loadAssignedPlanSnapshot, loadPlanBenefitsForSimulation } from '../api/assigned-plan-snapshot';
import { testAssignmentWrite } from './assignmentFixture';

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

/** A running assignment of a monthly plan carrying one one-off Product line. */
async function running(): Promise<{ um: number; productId: number }> {
  const m = Number(must(await auth(request.post('/members'))
    .send({ name: 'Snapshot Reader', email: `psr-${uniq()}@test.com`, default_center_id: centerId }), 'member').body.id);
  const { insertId: planId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', 1)`, [gymId, `PSR Plan ${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, 30, '2020-01-01', 'active')`, [gymId, planId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, planId]);
  const { insertId: productId } = await db.query(
    `INSERT INTO products (gym_id, name, type, amount, currency, billing_frequency, status, availability, is_system, tax_behavior)
     VALUES (?, ?, 'service', 12, 'EUR', 'once', 'active', 'available', 0, 'inclusive')`, [gymId, `psr-towel-${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_oneoff (gym_id, membership_plan_id, product_id, quantity) VALUES (?, ?, ?, 1)`,
    [gymId, planId, productId]);
  const um = await createTestDraftAssignment(gymId, m, Number(planId));
  must(await auth(request.post(`/user-memberships/${um}/activate`)).send({ on_conflict: 'add' }), 'activate');
  return { um, productId: Number(productId) };
}

/** Makes the legacy row unreachable from the gym, leaving every plan snapshot as it is. */
const moveLegacyRowAway = (um: number) =>
  testAssignmentWrite('UPDATE user_memberships SET gym_id = ? WHERE id = ?', [otherGymId, um]);

beforeAll(async () => {
  gymId = await createTestGym('Assignment Snapshot Readers Gym');
  otherGymId = await createTestGym('Assignment Snapshot Readers Other Gym');
  await createTestMembership(gymId, 'admin');
  ({ insertId: centerId } = await db.query('INSERT INTO centers (gym_id, name, status) VALUES (?, ?, ?)', [gymId, 'PSR Center', 'active']));
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('loadAssignedPlanSnapshot reads the assignment from plan_snapshots', () => {
  it('reports the snapshot\'s fee and cadence with no legacy row in the gym', async () => {
    const { um, productId } = await running();
    await db.query('UPDATE plan_snapshots SET membership_fee_price = 42 WHERE gym_id = ? AND source_user_membership_id = ?', [gymId, um]);
    await moveLegacyRowAway(um);
    const snap = await loadAssignedPlanSnapshot(gymId, um);
    expect(Number(snap.membership_fee_price)).toBe(42);
    expect(snap.recurring_billing_unit).toBe('month');
    expect(snap.oneoff_benefits.map((b) => Number(b.product_id))).toEqual([productId]);
  });

  it('reports nothing for another gym\'s assignment', async () => {
    const { um } = await running();
    const snap = await loadAssignedPlanSnapshot(otherGymId, um);
    expect(snap.membership_fee_price ?? null).toBeNull();
    expect(snap.oneoff_benefits).toEqual([]);
  });
});

describe('loadPlanBenefitsForSimulation reads the assignment from plan_snapshots', () => {
  it('loads the plan\'s lines with no legacy row in the gym', async () => {
    const { um, productId } = await running();
    await moveLegacyRowAway(um);
    const lines = await loadPlanBenefitsForSimulation(gymId, [{ id: um, membershipPlanId: null, hasBillingSnapshot: true }]);
    expect((lines.get(um) ?? []).map((l) => l.productId)).toEqual([productId]);
  });

  it('loads nothing for another gym\'s assignment or an unknown id', async () => {
    const { um } = await running();
    expect((await loadPlanBenefitsForSimulation(otherGymId, [{ id: um, membershipPlanId: null, hasBillingSnapshot: true }])).size).toBe(0);
    expect((await loadPlanBenefitsForSimulation(gymId, [{ id: 999999999, membershipPlanId: null, hasBillingSnapshot: true }])).size).toBe(0);
  });
});
