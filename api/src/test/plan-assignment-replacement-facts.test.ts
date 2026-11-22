// #2125 M6b-51c-2: an assignment's replacement (`replace_on_activation`, `replaces_assignment_id`) and
// deletion pair live on its plan snapshot. The snapshot sync no longer copies them from
// `user_memberships`, and a snapshot that comes to name another assignment drops the previous one's.
import { TEST_ASSIGNMENTS } from './assignmentReads';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment, createTestGym, createTestMembership, request,
} from './helpers';
import { nameAssignmentSnapshot } from '../api/plan-assignment-sync';
import { syncPlanSnapshot } from '../api/plan-snapshot-sync';
import { findPlanAssignmentDrift } from '../api/plan-assignment-drift';
import { testAssignmentWrite } from './assignmentFixture';

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const TODAY = new Date().toISOString().slice(0, 10);
const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Replacement Member', `parf-${uniq()}@test.com`]);
  return Number(insertId);
}
async function plan(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', 2)`, [gymId, `PARF Plan ${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, 10, '2020-01-01', 'active')`, [gymId, insertId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return Number(insertId);
}
async function activate(um: number): Promise<void> {
  const res = await auth(request.post(`/user-memberships/${um}/activate`)).send({ on_conflict: 'add' });
  if (res.status >= 300) throw new Error(`activate: ${res.status} ${JSON.stringify(res.body)}`);
}
async function snapshotOf(um: number) {
  const { rows } = await db.query<any>(
    `SELECT id, assignment_id, replace_on_activation, replaces_assignment_id, deleted_at
       FROM plan_snapshots WHERE gym_id = ? AND assignment_id = ? ORDER BY id DESC LIMIT 1`, [gymId, um]);
  const r = rows[0];
  return {
    id: Number(r.id), assignmentId: Number(r.assignment_id), replaceOnActivation: Number(r.replace_on_activation),
    replacesAssignmentId: r.replaces_assignment_id == null ? null : Number(r.replaces_assignment_id),
    deletedAt: r.deleted_at,
  };
}
async function setOf(um: number): Promise<number> {
  const { rows } = await db.query<any>(
    `SELECT psj.product_set_id AS id FROM product_set_plan_snapshots psj
       JOIN plan_snapshots s ON s.id = psj.plan_snapshot_id
      WHERE s.gym_id = ? AND s.assignment_id = ? ORDER BY psj.product_set_id DESC LIMIT 1`, [gymId, um]);
  return Number(rows[0].id);
}

beforeAll(async () => {
  gymId = await createTestGym('Plan Assignment Replacement Facts Gym');
  await createTestMembership(gymId, 'admin');
});
afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('an assignment\'s replacement is its plan snapshot\'s', () => {
  it('a re-derivation keeps the snapshot\'s replacement whatever the legacy row says', async () => {
    const original = await createTestDraftAssignment(gymId, await member(), await plan());
    await activate(original);
    const originalAnchor = (await snapshotOf(original)).assignmentId;

    const res = await auth(request.post(`/user-memberships/${original}/assign-new-plan`))
      .send({ membership_plan_id: await plan(), starts_at: TODAY });
    expect(res.status).toBe(201);
    const replacement = Number(res.body.id);
    expect(await snapshotOf(replacement)).toMatchObject({ replaceOnActivation: 0, replacesAssignmentId: originalAnchor });

    // The legacy row disagrees on every fact; nothing reads it any more.
    await testAssignmentWrite(
      `UPDATE user_memberships SET replace_on_activation = 1, replaces_user_membership_id = NULL,
              deleted_at = UTC_TIMESTAMP(), deleted_by = 'Legacy' WHERE id = ?`, [replacement], { mirror: false });
    const set = await setOf(replacement);
    await db.transaction((tx) => syncPlanSnapshot(tx, gymId, set));

    expect(await snapshotOf(replacement)).toMatchObject({
      replaceOnActivation: 0, replacesAssignmentId: originalAnchor, deletedAt: null,
    });
  });

  it('a snapshot named after another assignment drops the previous assignment\'s replacement', async () => {
    const m = await member();
    const replaced = await createTestDraftAssignment(gymId, m, await plan());
    await activate(replaced);
    const replacedAnchor = (await snapshotOf(replaced)).assignmentId;

    const first = await createTestDraftAssignment(gymId, m, await plan());
    const set = await setOf(first);
    const snapshot = (await snapshotOf(first)).id;
    // The snapshot carries the first assignment's replacement, as a copy made for an edit does.
    await db.query(
      'UPDATE plan_snapshots SET replace_on_activation = 1, replaces_assignment_id = ? WHERE id = ?',
      [replacedAnchor, snapshot]);

    const { rows: firstRow } = await db.query<any>(
      `SELECT member_id, gym_id, membership_plan_id, starts_at FROM ${TEST_ASSIGNMENTS} um WHERE id = ?`, [first]);
    const { insertId } = await testAssignmentWrite(
      `INSERT INTO user_memberships (member_id, gym_id, membership_plan_id, starts_at, status, created_by)
       VALUES (?, ?, ?, ?, 'in_cart', 'Test')`,
      [firstRow[0].member_id, firstRow[0].gym_id, firstRow[0].membership_plan_id, firstRow[0].starts_at]);
    const second = Number(insertId);
    await db.transaction(async (tx) => {
      await nameAssignmentSnapshot(tx, gymId, set, second);
      await syncPlanSnapshot(tx, gymId, set);
    });

    const { rows } = await db.query<any>(
      'SELECT assignment_id, replace_on_activation, replaces_assignment_id FROM plan_snapshots WHERE id = ?',
      [snapshot]);
    expect(Number(rows[0].assignment_id)).toBe(second);
    expect(Number(rows[0].replace_on_activation)).toBe(0);
    expect(rows[0].replaces_assignment_id).toBeNull();

    const report = await findPlanAssignmentDrift(db, gymId);
    for (const c of report.checks.filter((c) => /replace/.test(c.name))) {
      expect(c.sample.filter((r) => Number(r.user_membership_id) === second), c.name).toEqual([]);
    }
  });
});
