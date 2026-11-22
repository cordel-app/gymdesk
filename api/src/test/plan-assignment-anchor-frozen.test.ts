// #2125 M8: an assignment's anchor snapshot, once set, never moves. Every pointer to an assignment
// (`product_sets.plan_assignment_id`, `payment_requests.plan_assignment_id`, `replaces_assignment_id`)
// is keyed on it, so a snapshot named after the assignment later — even one with a lower id — joins
// the existing anchor instead of becoming a new one, and a snapshot that anchors an assignment other
// snapshots still belong to cannot be renamed after another assignment.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym, createTestMembership } from './helpers';
import { findPlanAssignmentDrift } from '../api/plan-assignment-drift';
import { nameAssignmentSnapshot, openAssignmentOnSet, planAssignmentIdOf, stampAssignmentIds } from '../api/plan-assignment-sync';
import { copyPlanSnapshotToVersion } from '../api/plan-snapshot-add';
import { createDraft } from '../api/product-sets';
import { snapshotProductSetFromPlan } from '../api/product-set-configuration';

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const TODAY = new Date().toISOString().slice(0, 10);

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Anchor Member', `anc-${uniq()}@test.com`]);
  return Number(insertId);
}
async function plan(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', 2)`, [gymId, `Anchor Plan ${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, 10, '2020-01-01', 'active')`, [gymId, insertId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return Number(insertId);
}
/** A Draft Product Set of a new owner with one plan snapshot of its own, named after no assignment. */
async function draftSet(): Promise<{ set: number; snapshot: number }> {
  const owner = await member();
  const planId = await plan();
  const set = await db.transaction(async (tx) => {
    const d = await createDraft(tx, { gymId, ownerMemberId: owner, membershipPlanId: planId, startsAt: TODAY, actor: { name: 'T', type: 'staff' } });
    if (d.kind !== 'created') throw new Error(d.kind);
    await snapshotProductSetFromPlan(tx, { gymId, productSetId: d.productSet.id, membershipPlanId: planId, membershipFeePrice: 10, startsAt: TODAY });
    return d.productSet.id;
  });
  const { rows } = await db.query<any>('SELECT plan_snapshot_id AS id FROM product_set_plan_snapshots WHERE product_set_id = ?', [set]);
  return { set, snapshot: Number(rows[0].id) };
}
/** Opens an assignment on the set's own plan snapshot, as the creation paths do (#2125 N1). */
async function assign(set: number): Promise<number> {
  return db.transaction((tx) => openAssignmentOnSet(tx, gymId, set));
}
const assignmentIdOf = async (snapshotId: number) => {
  const { rows } = await db.query<any>('SELECT assignment_id FROM plan_snapshots WHERE id = ?', [snapshotId]);
  return rows[0].assignment_id == null ? null : Number(rows[0].assignment_id);
};
const drift = async (name: string) => (await findPlanAssignmentDrift(db, gymId)).checks.find((c) => c.name === name)!;

beforeAll(async () => {
  gymId = await createTestGym('Plan Assignment Anchor Gym');
  await createTestMembership(gymId, 'admin');
});
afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('an assignment anchor never moves', () => {
  it('a lower snapshot named after the assignment later joins the existing anchor', async () => {
    const lower = await draftSet();
    const higher = await draftSet();
    expect(lower.snapshot).toBeLessThan(higher.snapshot);
    const um = await assign(higher.set);
    expect(await assignmentIdOf(higher.snapshot)).toBe(higher.snapshot);

    await db.transaction((tx) => nameAssignmentSnapshot(tx, gymId, lower.set, um));
    // A re-stamp of either snapshot leaves the anchor where it is.
    await db.transaction((tx) => stampAssignmentIds(tx, gymId, [lower.snapshot, higher.snapshot]));

    expect(await assignmentIdOf(lower.snapshot)).toBe(higher.snapshot);
    expect(await assignmentIdOf(higher.snapshot)).toBe(higher.snapshot);
    expect(await planAssignmentIdOf(db, gymId, um)).toBe(higher.snapshot);
    expect((await drift('assignment_identity_split')).count).toBe(0);
  });

  it('a snapshot anchoring an assignment other snapshots belong to cannot be renamed after another one', async () => {
    const a = await draftSet();
    const b = await draftSet();
    const um = await assign(a.set);
    const copy = await db.transaction((tx) => copyPlanSnapshotToVersion(tx, gymId, a.snapshot, b.set, { keepAssignment: true }));
    expect(await assignmentIdOf(copy)).toBe(a.snapshot);

    const other = await assign((await draftSet()).set);
    await expect(db.transaction((tx) => nameAssignmentSnapshot(tx, gymId, a.set, other)))
      .rejects.toThrow(/anchors assignment/);

    const { rows } = await db.query<any>('SELECT source_user_membership_id AS um FROM plan_snapshots WHERE id = ?', [a.snapshot]);
    expect(Number(rows[0].um)).toBe(um);
    expect(await assignmentIdOf(a.snapshot)).toBe(a.snapshot);
  });

  it('naming the anchor after its own assignment again is not a rename', async () => {
    const a = await draftSet();
    const b = await draftSet();
    const um = await assign(a.set);
    await db.transaction((tx) => copyPlanSnapshotToVersion(tx, gymId, a.snapshot, b.set, { keepAssignment: true }));
    await db.transaction((tx) => nameAssignmentSnapshot(tx, gymId, a.set, um));
    expect(await assignmentIdOf(a.snapshot)).toBe(a.snapshot);
  });
});
