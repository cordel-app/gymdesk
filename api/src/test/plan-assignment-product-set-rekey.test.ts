/**
 * #2125 M6b-36 / N3b — a Product Set is linked to the assignment it projects. Since N3b (migration 471)
 * the link is the `projects_assignment` flag of its `product_set_plan_snapshots` rows whose snapshot
 * names that assignment (`linkProductSetToAssignment()`), read through `productSetAssignmentSql()`;
 * `product_sets` has no column for it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { productSetAssignmentSql, productSetOfLegacyAssignmentSql, productSetLegacyAssignmentIdSql } from '../domain/planAssignments';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym, createTestMembership, request, TEST_AUTH_HEADER } from './helpers';
import { createDraft, addCoverage } from '../api/product-sets';
import { activateWithEvents, snapshotProductSetFromPlan } from '../api/product-set-configuration';
import { linkProductSetToAssignment } from '../api/plan-assignment-sync';
import { findPlanAssignmentDrift } from '../api/plan-assignment-drift';

let gymId: string;
let planId: number;
let secondPlanId: number;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}`;
const TODAY = new Date().toISOString().slice(0, 10);
const actor = { name: 'T', type: 'staff' };

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'M', `ps-rekey-${uniq()}@example.com`]);
  return Number(insertId);
}
async function plan(name: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', '1')`, [gymId, `${name}-${uniq()}`]);
  const id = Number(insertId);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, 30, '2020-01-01', 'active')`, [gymId, id]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, id]);
  return id;
}
/** Commits a first version for `owner`, returning its set id. */
async function commit(owner: number): Promise<number> {
  return db.transaction(async (tx) => {
    const d = await createDraft(tx, { gymId, ownerMemberId: owner, membershipPlanId: planId, startsAt: TODAY, actor });
    if (d.kind !== 'created') throw new Error(d.kind);
    await snapshotProductSetFromPlan(tx, { gymId, productSetId: d.productSet.id, membershipPlanId: planId, membershipFeePrice: 30, startsAt: TODAY });
    await addCoverage(tx, { gymId, productSetId: d.productSet.id, memberId: owner, isOwner: true });
    const out = await activateWithEvents(tx, { gymId, productSetId: d.productSet.id, today: TODAY });
    if (out.kind !== 'ok') throw new Error(out.kind);
    return d.productSet.id;
  });
}
async function anchorOf(um: number): Promise<number> {
  const { rows } = await db.query<any>(
    'SELECT MIN(id) AS a FROM plan_snapshots WHERE gym_id = ? AND anchor_plan_snapshot_id = ?', [gymId, um]);
  return Number(rows[0].a);
}
async function setOf(setId: number): Promise<{ um: number | null; key: number | null }> {
  const { rows } = await db.query<any>(`SELECT ${productSetLegacyAssignmentIdSql('product_sets')} AS user_membership_id, ${productSetAssignmentSql('product_sets')} AS plan_assignment_id FROM product_sets WHERE id = ?`, [setId]);
  const n = (v: unknown) => (v == null ? null : Number(v));
  return { um: n(rows[0].user_membership_id), key: n(rows[0].plan_assignment_id) };
}
async function setDrift() {
  const report = await findPlanAssignmentDrift(db as any, gymId);
  return report.checks.find((c) => c.name === 'product_set_assignment_mismatch')!;
}

beforeAll(async () => {
  gymId = await createTestGym('Product set re-key gym');
  await createTestMembership(gymId, 'admin');
  planId = await plan('PsRekey');
  secondPlanId = await plan('PsRekey2');
});
afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('#2125 M6b-36: a Product Set is linked to the assignment it projects', () => {
  it('a committed version takes the anchor of the assignment it projects', async () => {
    const setId = await commit(await member());
    const { um, key } = await setOf(setId);
    expect(um).not.toBeNull();
    expect(key).toBe(await anchorOf(um!));
  });

  it('an uncommitted Draft that projects nothing is linked to no assignment', async () => {
    const owner = await member();
    const setId = await db.transaction(async (tx) => {
      const d = await createDraft(tx, { gymId, ownerMemberId: owner, membershipPlanId: planId, startsAt: TODAY, actor });
      if (d.kind !== 'created') throw new Error(d.kind);
      return d.productSet.id;
    });
    expect(await setOf(setId)).toEqual({ um: null, key: null });
  });

  it('the Admin assignment flow (Draft, activate, assign a new plan, activate) leaves no Product Set drifted', async () => {
    const owner = await member();
    const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    const first = await auth(request.post('/user-memberships'))
      .send({ member_id: owner, membership_plan_id: planId, starts_at: TODAY });
    expect(first.status).toBe(201);
    const { rows: drafts } = await db.query<any>(
      `SELECT id FROM product_sets WHERE gym_id = ? AND ${productSetOfLegacyAssignmentSql('?', 'product_sets')}`, [gymId, first.body.id]);
    expect(await setOf(Number(drafts[0].id))).toEqual({ um: Number(first.body.id), key: await anchorOf(first.body.id) });
    expect((await auth(request.post(`/user-memberships/${first.body.id}/activate`)).send({})).status).toBe(200);
    const second = await auth(request.post(`/user-memberships/${first.body.id}/assign-new-plan`))
      .send({ membership_plan_id: secondPlanId, starts_at: TODAY });
    expect(second.status).toBe(201);
    expect((await auth(request.post(`/user-memberships/${second.body.id}/activate`)).send({ on_conflict: 'replace' })).status).toBe(200);
    expect((await setDrift()).count).toBe(0);
  });

  it('a plain Draft linking the running plan\'s snapshot unchanged is not linked to its assignment', async () => {
    const owner = await member();
    const active = await commit(owner);
    const { um } = await setOf(active);
    const draftId = await db.transaction(async (tx) => {
      const d = await createDraft(tx, { gymId, ownerMemberId: owner, membershipPlanId: planId, startsAt: TODAY, actor });
      if (d.kind !== 'created') throw new Error(d.kind);
      await tx.query(
        `INSERT INTO product_set_plan_snapshots (product_set_id, plan_snapshot_id)
         SELECT ?, plan_snapshot_id FROM product_set_plan_snapshots WHERE product_set_id = ?`, [d.productSet.id, active]);
      return d.productSet.id;
    });
    expect(await setOf(draftId)).toEqual({ um: null, key: null });
    expect((await setOf(active)).um).toBe(um);
  });

  it('linking a set to an assignment none of its snapshots names is refused', async () => {
    const owner = await member();
    const setId = await db.transaction(async (tx) => {
      const d = await createDraft(tx, { gymId, ownerMemberId: owner, membershipPlanId: planId, startsAt: TODAY, actor });
      if (d.kind !== 'created') throw new Error(d.kind);
      return d.productSet.id;
    });
    const other = await commit(await member());
    const { um } = await setOf(other);
    await expect(db.transaction((tx) => linkProductSetToAssignment(tx, gymId, setId, um!)))
      .rejects.toThrow(/links no plan snapshot of assignment/);
  });

  it('plan-assignments:validate reports a set flagged on two assignments', async () => {
    expect((await setDrift()).count).toBe(0);
    const setId = await commit(await member());
    const other = await commit(await member());
    const { um: otherUm } = await setOf(other);
    await db.query(
      'INSERT INTO product_set_plan_snapshots (product_set_id, plan_snapshot_id, projects_assignment) VALUES (?, ?, 1)',
      [setId, otherUm]);
    const drift = await setDrift();
    expect(drift.sample.map((r: any) => [Number(r.product_set_id), Number(r.assignments)])).toEqual([[setId, 2]]);
    await db.query('DELETE FROM product_set_plan_snapshots WHERE product_set_id = ? AND plan_snapshot_id = ?', [setId, otherUm]);
    expect((await setDrift()).count).toBe(0);
  });
});
