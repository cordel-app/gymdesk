// #2125 M6b-26: which version an assignment's version-level lines (recurring Products and services)
// are read from (`assignmentLineVersionId()`) asks the assignment's status of its current plan
// snapshot, not of the `user_memberships` row. A still-active assignment whose version was
// superseded (after an Add) reads no lines; a closed one keeps its own version's lines. Each test
// makes the snapshot and the legacy row disagree and asserts the snapshot wins.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment, createTestGym, createTestMembership, request,
} from './helpers';
import { currentAssignmentSnapshotSql } from '../domain/planAssignments';
import { legacyProductInsert } from './legacyProductFixture';

let gymId: string;
let otherGymId: string;
let centerId: number;
let productId: number;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const auth = (r: any, gym = gymId) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);
const must = (res: any, what: string) => {
  if (res.status >= 300) throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body)}`);
  return res;
};

async function member(): Promise<number> {
  return Number(must(await auth(request.post('/members'))
    .send({ name: 'Line Version Reader', email: `lvr-${uniq()}@test.com`, default_center_id: centerId }), 'member').body.id);
}
async function plan(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', 2)`, [gymId, `LVR Plan ${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, 10, '2020-01-01', 'active')`, [gymId, insertId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return Number(insertId);
}
/** A member holding one running plan with a recurring 5-session line of the test Product. */
async function runningWithService(): Promise<{ m: number; um: number }> {
  const m = await member();
  const um = await createTestDraftAssignment(gymId, m, await plan());
  must(await auth(request.post(`/user-memberships/${um}/activate`)).send({ on_conflict: 'add' }), 'activate');
  // A recurring session line on the Active Product Set, as one-active-membership-plan.test.ts seeds it.
  const { rows } = await db.query<any>(
    "SELECT id FROM product_sets WHERE gym_id = ? AND owner_member_id = ? AND status = 'active'", [gymId, m]);
  await legacyProductInsert(`INSERT INTO member_products_recurrent_snapshot (gym_id, product_set_id, product_id, quantity, starts_at,
       item_name, item_type, unit_price, item_billing_frequency, currency)
     VALUES (?, ?, ?, 1, UTC_DATE() - INTERVAL 1 DAY, 'Pack', 'sessions', 20, 'month', 'EUR')`, [gymId, rows[0].id, productId]);
  return { m, um };
}
async function currentSnapshotId(um: number): Promise<number> {
  const { rows } = await db.query<any>(
    `SELECT ${currentAssignmentSnapshotSql('a.assignment_id', 'a.gym_id')} AS id
       FROM plan_snapshots a WHERE a.gym_id = ? AND a.source_user_membership_id = ? LIMIT 1`, [gymId, um]);
  return Number(rows[0].id);
}

beforeAll(async () => {
  gymId = await createTestGym('Assignment Line Version Gym');
  otherGymId = await createTestGym('Assignment Line Version Other Gym');
  await createTestMembership(gymId, 'admin');
  await createTestMembership(otherGymId, 'admin');
  ({ insertId: centerId } = await db.query('INSERT INTO centers (gym_id, name, status) VALUES (?, ?, ?)', [gymId, 'LVR Center', 'active']));
  ({ insertId: productId } = await db.query(
    `INSERT INTO products (gym_id, name, type, units, amount, currency, billing_frequency, status, availability, is_system)
     VALUES (?, ?, 'sessions', 5, 20.00, 'EUR', 'month', 'active', 'available', 0)`, [gymId, `LVR Pack ${uniq()}`]));
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

const services = async (um: number) =>
  must(await auth(request.get(`/user-memberships/${um}/services`)), 'services').body as any[];
/** Marks the assignment's linked version superseded, as an Add leaves it. */
const supersedeVersion = (um: number) =>
  db.query("UPDATE product_sets SET status = 'superseded' WHERE gym_id = ? AND user_membership_id = ?", [gymId, um]);

describe('assignmentLineVersionId() reads the assignment\'s status from plan_snapshots', () => {
  it('a running plan on its Active version lists its recurring line', async () => {
    const { um } = await runningWithService();
    expect(await services(um)).toHaveLength(1);
  });

  it('an active snapshot on a superseded version reads no lines, even when the legacy row says cancelled', async () => {
    const { um } = await runningWithService();
    await supersedeVersion(um);
    await db.query("UPDATE user_memberships SET status = 'cancelled' WHERE id = ?", [um]);
    expect(await services(um)).toHaveLength(0);
  });

  it('a cancelled snapshot keeps its own version\'s lines, even when the legacy row says active', async () => {
    const { um } = await runningWithService();
    await supersedeVersion(um);
    await db.query("UPDATE plan_snapshots SET status = 'cancelled' WHERE id = ?", [await currentSnapshotId(um)]);
    await db.query("UPDATE user_memberships SET status = 'active' WHERE id = ?", [um]);
    expect(await services(um)).toHaveLength(1);
  });
});
