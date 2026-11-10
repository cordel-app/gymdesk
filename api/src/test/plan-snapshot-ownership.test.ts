// #2125 M4a — a Product Set edits only the plan snapshots it owns, and "inherited" can be derived from a link.
// M4b-1 — the sync reads a set's plans from the junction and never writes a snapshot another set links.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym } from './helpers';
import { createDraft } from '../api/product-sets';
import { snapshotProductSetFromPlan } from '../api/product-set-configuration';
import { ownPlanSnapshot, ownPlanSnapshotsOfSet, discardDraftSet } from '../api/plan-snapshot-ownership';
import { planSnapshotInheritedSql } from '../api/plan-snapshot-lines';
import { syncPlanSnapshot } from '../api/plan-snapshot-sync';

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}`;
const TODAY = new Date().toISOString().slice(0, 10);
const actor = { name: 'T', type: 'staff' };

beforeAll(async () => { gymId = await createTestGym('Snapshot ownership gym'); });
afterAll(async () => { await cleanupTestGyms(); await db.end(); });

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'M', `own-${uniq()}@example.com`]);
  return insertId;
}
async function plan(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', '2')`, [gymId, `Own-${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, 20, '2020-01-01', 'active')`, [gymId, insertId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return Number(insertId);
}
/** Two Product Sets of one owner, B after A; returns A's plan snapshot. */
async function twoSets(): Promise<{ a: number; b: number; snapshot: number }> {
  const owner = await member();
  const planId = await plan();
  const a = await db.transaction(async (tx) => {
    const d = await createDraft(tx, { gymId, ownerMemberId: owner, membershipPlanId: planId, startsAt: TODAY, actor });
    if (d.kind !== 'created') throw new Error(d.kind);
    await snapshotProductSetFromPlan(tx, { gymId, productSetId: d.productSet.id, membershipPlanId: planId, membershipFeePrice: 20, startsAt: TODAY });
    await tx.query("UPDATE product_sets SET status = 'superseded' WHERE id = ?", [d.productSet.id]);
    return d.productSet.id;
  });
  const b = await db.transaction(async (tx) => {
    const d = await createDraft(tx, { gymId, ownerMemberId: owner, membershipPlanId: planId, startsAt: TODAY, actor });
    if (d.kind !== 'created') throw new Error(d.kind);
    return d.productSet.id;
  });
  await db.query('UPDATE product_sets SET previous_product_set_id = ? WHERE id = ?', [a, b]);
  const { rows } = await db.query<any>('SELECT plan_snapshot_id FROM product_set_plan_snapshots WHERE product_set_id = ?', [a]);
  return { a, b, snapshot: Number(rows[0].plan_snapshot_id) };
}
const linked = async (setId: number) =>
  (await db.query<any>('SELECT plan_snapshot_id AS s FROM product_set_plan_snapshots WHERE product_set_id = ? ORDER BY 1', [setId])).rows.map((r: any) => Number(r.s));

describe('ownPlanSnapshot (#2125 M4a)', () => {
  it('returns the snapshot untouched when no other Product Set uses it', async () => {
    const { a, snapshot } = await twoSets();
    expect(await db.transaction((tx) => ownPlanSnapshot(tx, gymId, a, snapshot))).toBe(snapshot);
    expect(await linked(a)).toEqual([snapshot]);
  });

  it('copies a shared snapshot for the set being edited and leaves the other set\'s alone', async () => {
    const { a, b, snapshot } = await twoSets();
    await db.query('INSERT INTO product_set_plan_snapshots (product_set_id, plan_snapshot_id) VALUES (?, ?)', [b, snapshot]);

    const own = await db.transaction((tx) => ownPlanSnapshot(tx, gymId, b, snapshot));
    expect(own).not.toBe(snapshot);
    expect(await linked(b)).toEqual([own]);
    expect(await linked(a)).toEqual([snapshot]);

    // The copy carries the same configuration and beneficiaries, and editing it does not touch the original.
    const { rows } = await db.query<any>('SELECT membership_fee_price AS fee FROM plan_snapshots WHERE id IN (?, ?) ORDER BY id', [snapshot, own]);
    expect(rows.map((r: any) => Number(r.fee))).toEqual([20, 20]);
    const { rows: ben } = await db.query<any>('SELECT plan_snapshot_id FROM plan_snapshot_beneficiaries WHERE plan_snapshot_id IN (?, ?)', [snapshot, own]);
    expect(ben).toHaveLength(2);
    await db.query('UPDATE plan_snapshots SET membership_fee_price = 99 WHERE id = ?', [own]);
    const { rows: orig } = await db.query<any>('SELECT membership_fee_price AS fee FROM plan_snapshots WHERE id = ?', [snapshot]);
    expect(Number(orig[0].fee)).toBe(20);
  });
});

describe('planSnapshotInheritedSql (#2125 M4a)', () => {
  it('is true for a snapshot the previous Product Set also links, false for one the set added', async () => {
    const { b, snapshot } = await twoSets();
    const inherited = async (setId: number, snapId: number) => Number((await db.query<any>(
      `SELECT ${planSnapshotInheritedSql('s', '?')} AS i FROM plan_snapshots s WHERE s.id = ?`, [setId, snapId])).rows[0].i);
    // Not linked by B's predecessor and not flagged: added by B.
    const { rows: own } = await db.query<any>('SELECT plan_snapshot_id FROM product_set_plan_snapshots WHERE product_set_id = ?', [b]);
    expect(own).toHaveLength(0);
    // The original is linked by A, B's previous: seen from B it carries over.
    expect(await inherited(b, snapshot)).toBe(1);
    // A snapshot nobody else links, with the flag off, is new.
    const { insertId } = await db.query(
      `INSERT INTO plan_snapshots (gym_id, product_set_id, member_id, membership_plan_id, status, starts_at, is_inherited)
       SELECT gym_id, ?, member_id, membership_plan_id, 'draft', starts_at, 0 FROM plan_snapshots WHERE id = ?`, [b, snapshot]);
    expect(await inherited(b, Number(insertId))).toBe(0);
  });
});

describe('ownPlanSnapshotsOfSet and discardDraftSet (#2125 M4b-0)', () => {
  it('owns every shared snapshot of the set, leaving the other set on the original', async () => {
    const { a, b, snapshot } = await twoSets();
    await db.query('INSERT INTO product_set_plan_snapshots (product_set_id, plan_snapshot_id) VALUES (?, ?)', [b, snapshot]);
    await db.transaction((tx) => ownPlanSnapshotsOfSet(tx, gymId, b));
    expect(await linked(a)).toEqual([snapshot]);
    const mine = await linked(b);
    expect(mine).toHaveLength(1);
    expect(mine[0]).not.toBe(snapshot);
  });

  it('discarding a Draft keeps a snapshot another set still links, and only a Draft is deleted', async () => {
    const { a, b, snapshot } = await twoSets();
    // The snapshot's own set pointer is the Draft's; the superseded A links it too.
    await db.query('UPDATE plan_snapshots SET product_set_id = ? WHERE id = ?', [b, snapshot]);
    await db.query('INSERT INTO product_set_plan_snapshots (product_set_id, plan_snapshot_id) VALUES (?, ?)', [b, snapshot]);
    expect(await db.transaction((tx) => discardDraftSet(tx, gymId, b))).toBe(true);
    const { rows } = await db.query<any>('SELECT product_set_id FROM plan_snapshots WHERE id = ?', [snapshot]);
    expect(Number(rows[0].product_set_id)).toBe(a);
    // A (superseded) is not a Draft: nothing is deleted.
    expect(await db.transaction((tx) => discardDraftSet(tx, gymId, a))).toBe(false);
  });
});

describe('syncPlanSnapshot and a shared plan snapshot (#2125 M4b-1)', () => {
  const state = async (snapId: number) => {
    const { rows } = await db.query<any>(
      `SELECT status, starts_at, ends_at, closed_at, member_id, source_user_membership_id,
              (SELECT COUNT(*) FROM plan_snapshot_beneficiaries b WHERE b.plan_snapshot_id = s.id) AS beneficiaries
         FROM plan_snapshots s WHERE id = ?`, [snapId]);
    return rows[0];
  };

  it('keeps a link the column disagrees with, and leaves a snapshot two sets link exactly as it is', async () => {
    const { a, b, snapshot } = await twoSets();
    await db.transaction((tx) => syncPlanSnapshot(tx, gymId, a));
    const before = await state(snapshot);
    expect(before.status).toBe('superseded');

    // The Draft B reuses A's plan unchanged: a link, not a copy. The snapshot's own column still names A.
    await db.query('INSERT INTO product_set_plan_snapshots (product_set_id, plan_snapshot_id) VALUES (?, ?)', [b, snapshot]);
    await db.query('UPDATE product_sets SET starts_at = DATE_ADD(starts_at, INTERVAL 7 DAY) WHERE id = ?', [b]);

    await db.transaction((tx) => syncPlanSnapshot(tx, gymId, b));
    // The junction is the record of the link: the sync does not drop it because the column says A.
    expect(await linked(b)).toEqual([snapshot]);
    expect(await linked(a)).toEqual([snapshot]);
    // Shared, so immutable: no status, date, member, assignment or beneficiary of it moved for B...
    expect(await state(snapshot)).toEqual(before);
    // ...nor for A, which also links it.
    await db.transaction((tx) => syncPlanSnapshot(tx, gymId, a));
    expect(await state(snapshot)).toEqual(before);
  });

  it('moves a snapshot again once the set owns it alone', async () => {
    const { a, b, snapshot } = await twoSets();
    await db.transaction((tx) => syncPlanSnapshot(tx, gymId, a));
    const before = await state(snapshot);
    await db.query('INSERT INTO product_set_plan_snapshots (product_set_id, plan_snapshot_id) VALUES (?, ?)', [b, snapshot]);
    await db.query('UPDATE product_sets SET starts_at = DATE_ADD(starts_at, INTERVAL 7 DAY) WHERE id = ?', [b]);

    const own = await db.transaction((tx) => ownPlanSnapshot(tx, gymId, b, snapshot));
    await db.transaction((tx) => syncPlanSnapshot(tx, gymId, b));
    expect(await linked(b)).toEqual([own]);
    const copy = await state(own);
    expect(copy.status).toBe('draft');
    const { rows: setB } = await db.query<any>('SELECT starts_at FROM product_sets WHERE id = ?', [b]);
    expect(copy.starts_at).toEqual(setB[0].starts_at);
    expect(copy.starts_at).not.toEqual(before.starts_at);
    // The original is still A's alone and untouched.
    expect(await linked(a)).toEqual([snapshot]);
    expect(await state(snapshot)).toEqual(before);
  });
});
