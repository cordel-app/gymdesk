// #2125 M6b-12: an assignment's configuration and pricing are read from its current plan snapshot
// (the one the owner's Active Product Set links), never from a copy an uncommitted Draft owns.
// While a Draft links an edited copy of a running plan, the fee, Billing & Duration, the cadence and
// the included Products the Admin, the member and the nightly run see stay the Active set's
// (Oscar, 2026-11-15). A Draft assignment with no Active set still reads its own snapshot.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment, createTestGym, createTestMembership, request,
} from './helpers';
import { ownPlanSnapshot } from '../api/plan-snapshot-ownership';
import { loadPlanBenefitsForSimulation } from '../api/assigned-plan-snapshot';

let gymId: string;
let otherGymId: string;
let productId: number;
let centerId: number;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const auth = (r: any, gym = gymId) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);
const must = (res: any, what: string) => {
  if (res.status >= 300) throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body)}`);
  return res;
};

async function member(): Promise<number> {
  return Number(must(await auth(request.post('/members')).send({ name: 'Config Reader', email: `pcr-${uniq()}@test.com`, default_center_id: centerId }), 'member').body.id);
}
/** A monthly plan at 10 € with four included sessions (its snapshot negotiates no fee: NULL). */
async function plan(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', 2)`, [gymId, `PCR Plan ${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, 10, '2020-01-01', 'active')`, [gymId, insertId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  await db.query('INSERT INTO membership_plan_session (gym_id, membership_plan_id, product_id, quantity) VALUES (?, ?, ?, 4)',
    [gymId, insertId, productId]);
  return Number(insertId);
}
const getAssignment = (um: number, gym = gymId) => auth(request.get(`/user-memberships/${um}`), gym);

/** The plan snapshot the assignment's Active set links. */
async function activeSnapshot(um: number): Promise<number> {
  const { rows } = await db.query<any>(
    `SELECT s.id FROM plan_snapshots s
       JOIN product_set_plan_snapshots j ON j.plan_snapshot_id = s.id
       JOIN product_sets p ON p.id = j.product_set_id AND p.status = 'active'
      WHERE s.gym_id = ? AND s.assignment_id = ? ORDER BY s.id LIMIT 1`, [gymId, um]);
  return Number(rows[0].id);
}

/**
 * A running plan whose owner holds a plain Draft that owns an edited copy of it: the Draft's copy
 * says 99 €, a 2-month cadence, two free periods and 9 included sessions.
 */
async function runningWithEditedDraftCopy(): Promise<{ m: number; um: number; draftSet: number; copy: number }> {
  const m = await member();
  const um = await createTestDraftAssignment(gymId, m, await plan());
  must(await auth(request.post(`/user-memberships/${um}/activate`)).send({ on_conflict: 'add' }), 'activate');
  const draftSet = Number(must(await auth(request.post('/product-sets/draft')).send({ member_id: m }), 'draft').body.id);
  const shared = await activeSnapshot(um);
  const copy = await db.transaction((tx) => ownPlanSnapshot(tx, gymId, draftSet, shared));
  expect(copy).not.toBe(shared);
  await db.query(
    `UPDATE plan_snapshots SET membership_fee_price = 99, recurring_billing_interval = 2, free_periods = 2
      WHERE id = ? AND gym_id = ?`, [copy, gymId]);
  await db.query('UPDATE plan_session_snapshots SET quantity = 9 WHERE plan_snapshot_id = ? AND gym_id = ?', [copy, gymId]);
  return { m, um, draftSet, copy };
}

beforeAll(async () => {
  gymId = await createTestGym('Assignment Config Reader Gym');
  otherGymId = await createTestGym('Assignment Config Reader Other Gym');
  await createTestMembership(gymId, 'admin');
  await createTestMembership(otherGymId, 'admin');
  ({ insertId: centerId } = await db.query('INSERT INTO centers (gym_id, name, status) VALUES (?, ?, ?)', [gymId, 'PCR Center', 'active']));
  ({ insertId: productId } = await db.query(
    `INSERT INTO products (gym_id, name, type, units, amount, currency, billing_frequency, status, availability, is_system)
     VALUES (?, ?, 'sessions', 1, 20.00, 'EUR', 'once', 'active', 'available', 0)`, [gymId, `PCR Session ${uniq()}`]));
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('an assignment\'s configuration follows its current plan snapshot', () => {
  it('a Draft owning an edited copy of a running plan does not change what the running plan reads', async () => {
    const { um } = await runningWithEditedDraftCopy();
    const res = must(await getAssignment(um), 'get');
    expect(res.body.snapshot).toMatchObject({
      membership_fee_price: null,
      recurring_billing_interval: 1,
      recurring_billing_unit: 'month',
      free_periods: null,
    });
    expect(res.body.snapshot.session_benefits).toHaveLength(1);
    expect(res.body.snapshot.session_benefits[0]).toMatchObject({ quantity: 4, product_id: productId });
  });

  it('the engine prices the running plan from the Active set\'s lines, not the Draft copy\'s', async () => {
    const { um } = await runningWithEditedDraftCopy();
    const byAssignment = await loadPlanBenefitsForSimulation(gymId, [{ id: um, membershipPlanId: null, hasBillingSnapshot: true }]);
    expect(byAssignment.get(um)?.map((b) => b.quantity)).toEqual([4]);
  });

  it('a Draft assignment with no Active set still reads its own snapshot', async () => {
    const um = await createTestDraftAssignment(gymId, await member(), await plan());
    const res = must(await getAssignment(um), 'get');
    expect(res.body.snapshot).toMatchObject({ membership_fee_price: null, recurring_billing_interval: 1 });
    expect(res.body.snapshot.session_benefits[0]).toMatchObject({ quantity: 4 });
  });

  it('another gym and an anonymous caller cannot read the assignment', async () => {
    const { um } = await runningWithEditedDraftCopy();
    expect((await getAssignment(um, otherGymId)).status).toBe(404);
    expect((await request.get(`/user-memberships/${um}`)).status).toBe(401);
  });
});
