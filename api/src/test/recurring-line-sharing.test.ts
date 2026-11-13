// #2126 stage 5c-2b — a recurring line snapshot linked by two Product Sets is that pair's contract: the
// junction keeps the link, the status sync of one set never moves it, and the line writer refuses it.
// Lines are not linked across sets yet (5c-2c), so these tests link one by hand, as 5c-2c will.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym } from './helpers';
import { createDraft } from '../api/product-sets';
import { snapshotProductSetFromPlan } from '../api/product-set-configuration';
import { insertRecurringLine, updateRecurringLine } from '../api/recurring-line-writer';
import { syncProductSnapshotsOfVersion } from '../api/product-snapshot-sync';
import { isRecurringLineShared, SharedRecurringLineError } from '../api/recurring-line-sharing';
import { TEST_RECURRING_LINES } from './productSnapshotReads';

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}`;
const TODAY = new Date().toISOString().slice(0, 10);
const actor = { name: 'T', type: 'staff' };

beforeAll(async () => { gymId = await createTestGym('Recurring line sharing gym'); });
afterAll(async () => { await cleanupTestGyms(); await db.end(); });

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'M', `rls-${uniq()}@example.com`]);
  return insertId;
}
async function plan(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', '2')`, [gymId, `RLS-${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, 20, '2020-01-01', 'active')`, [gymId, insertId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return Number(insertId);
}
async function product(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, amount, status, is_system, currency)
     VALUES (?, ?, 'service', 'month', 12.50, 'active', 0, 'EUR')`, [gymId, `Locker ${uniq()}`]);
  return Number(insertId);
}
async function draftSet(owner: number): Promise<number> {
  const planId = await plan();
  return db.transaction(async (tx) => {
    const d = await createDraft(tx, { gymId, ownerMemberId: owner, membershipPlanId: planId, startsAt: TODAY, actor });
    if (d.kind !== 'created') throw new Error(d.kind);
    await snapshotProductSetFromPlan(tx, { gymId, productSetId: d.productSet.id, membershipPlanId: planId, membershipFeePrice: 20, startsAt: TODAY });
    return d.productSet.id;
  });
}

/** A line created by `creatorSet`, its snapshot also linked by a second set (the 5c-2c shape). */
async function sharedLine() {
  const creatorSet = await draftSet(await member());
  const otherSet = await draftSet(await member());
  const productId = await product();
  const lineId = await db.transaction((tx) =>
    insertRecurringLine(tx, { gymId, productSetId: creatorSet, productId, quantity: 1, startsAt: TODAY }));
  const snapshotId = Number((await db.query<any>(
    'SELECT id FROM product_periodical_snapshots WHERE source_id = ?', [lineId])).rows[0].id);
  await db.query('INSERT INTO product_set_periodical_snapshots (product_set_id, product_periodical_snapshot_id) VALUES (?, ?)',
    [otherSet, snapshotId]);
  return { creatorSet, otherSet, lineId: Number(lineId), snapshotId };
}

const links = async (snapshotId: number) =>
  (await db.query<any>('SELECT product_set_id FROM product_set_periodical_snapshots WHERE product_periodical_snapshot_id = ? ORDER BY product_set_id',
    [snapshotId])).rows.map((r: any) => Number(r.product_set_id));

describe('a shared recurring line (#2126 stage 5c-2b)', () => {
  it('is reported shared only to a set that is not the only one linking it', async () => {
    const { creatorSet, otherSet, snapshotId } = await sharedLine();
    expect(await isRecurringLineShared(db, creatorSet, snapshotId)).toBe(true);
    expect(await isRecurringLineShared(db, otherSet, snapshotId)).toBe(true);
    await db.query('DELETE FROM product_set_periodical_snapshots WHERE product_set_id = ? AND product_periodical_snapshot_id = ?',
      [otherSet, snapshotId]);
    expect(await isRecurringLineShared(db, creatorSet, snapshotId)).toBe(false);
  });

  it('keeps both links when either set is synced', async () => {
    const { creatorSet, otherSet, snapshotId } = await sharedLine();
    await db.transaction((tx) => syncProductSnapshotsOfVersion(tx, gymId, otherSet));
    await db.transaction((tx) => syncProductSnapshotsOfVersion(tx, gymId, creatorSet));
    expect(await links(snapshotId)).toEqual([creatorSet, otherSet].sort((a, b) => a - b));
  });

  it('does not take the status or owner of a set that is not its only one', async () => {
    const { creatorSet, otherSet, snapshotId } = await sharedLine();
    const before = (await db.query<any>('SELECT status, member_id FROM product_periodical_snapshots WHERE id = ?', [snapshotId])).rows[0];
    await db.query("UPDATE product_sets SET status = 'pending_payment' WHERE id = ?", [otherSet]);
    await db.transaction((tx) => syncProductSnapshotsOfVersion(tx, gymId, otherSet));
    await db.query("UPDATE product_sets SET status = 'pending_payment' WHERE id = ?", [creatorSet]);
    await db.transaction((tx) => syncProductSnapshotsOfVersion(tx, gymId, creatorSet));
    const after = (await db.query<any>('SELECT status, member_id FROM product_periodical_snapshots WHERE id = ?', [snapshotId])).rows[0];
    expect(after.status).toBe(before.status);
    expect(Number(after.member_id)).toBe(Number(before.member_id));
  });

  it('is refused by the line writer, and nothing is written', async () => {
    const { lineId, snapshotId } = await sharedLine();
    await expect(db.transaction((tx) => updateRecurringLine(tx, gymId, lineId, { quantity: 3 })))
      .rejects.toBeInstanceOf(SharedRecurringLineError);
    const legacy = (await db.query<any>(`SELECT quantity FROM ${TEST_RECURRING_LINES} AS legacy WHERE id = ?`, [lineId])).rows[0];
    const snap = (await db.query<any>('SELECT quantity FROM product_periodical_snapshots WHERE id = ?', [snapshotId])).rows[0];
    expect(Number(legacy.quantity)).toBe(1);
    expect(Number(snap.quantity)).toBe(1);
  });

  it('a line only its own set links still follows that set and is still written', async () => {
    const set = await draftSet(await member());
    const productId = await product();
    const id = Number(await db.transaction((tx) =>
      insertRecurringLine(tx, { gymId, productSetId: set, productId, quantity: 1, startsAt: TODAY })));
    await db.query("UPDATE product_sets SET status = 'pending_payment' WHERE id = ?", [set]);
    await db.transaction((tx) => syncProductSnapshotsOfVersion(tx, gymId, set));
    await db.transaction((tx) => updateRecurringLine(tx, gymId, id, { quantity: 2 }));
    const snap = (await db.query<any>('SELECT status, quantity FROM product_periodical_snapshots WHERE source_id = ?', [id])).rows[0];
    expect(snap.status).toBe('pending_payment');
    expect(Number(snap.quantity)).toBe(2);
  });
});
