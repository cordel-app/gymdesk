// #2126 stage 5c-2c — a Product Set writes only the recurring lines it owns. A line another set also links
// is copied for the set being edited before it is written (`ownRecurringLine()`), its link re-pointed at the
// copy, and the other set's line is left exactly as it was. Lines are not linked across sets yet, so these
// tests link one by hand, as the next sub-stage will.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym } from './helpers';
import { createDraft } from '../api/product-sets';
import { snapshotProductSetFromPlan } from '../api/product-set-configuration';
import { insertRecurringLine, ownRecurringLine } from '../api/recurring-line-writer';
import { lockDraft, removeService, setServiceQuantity, type LockedDraft } from '../api/product-set-draft';

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}`;
const TODAY = new Date().toISOString().slice(0, 10);
const actor = { name: 'T', type: 'staff' };

beforeAll(async () => { gymId = await createTestGym('Recurring line ownership gym'); });
afterAll(async () => { await cleanupTestGyms(); await db.end(); });

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'M', `rlo-${uniq()}@example.com`]);
  return insertId;
}
async function plan(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', '2')`, [gymId, `RLO-${uniq()}`]);
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


const linkedSnapshots = async (setId: number) =>
  (await db.query<any>(
    `SELECT s.id, s.source_id, s.quantity, s.ends_at, s.line_ref FROM product_set_periodical_snapshots j
       JOIN product_periodical_snapshots s ON s.id = j.product_periodical_snapshot_id
      WHERE j.product_set_id = ? ORDER BY s.id`, [setId])).rows;

const locked = (tx: any, setId: number) => lockDraft(tx, gymId, setId) as Promise<LockedDraft>;

describe('owning a recurring line (#2126 stage 5c-2c)', () => {
  it('answers the line itself when only the set links it, and copies nothing', async () => {
    const set = await draftSet(await member());
    const productId = await product();
    const lineId = Number(await db.transaction((tx) =>
      insertRecurringLine(tx, { gymId, productSetId: set, productId, quantity: 1, startsAt: TODAY })));
    expect(await db.transaction((tx) => ownRecurringLine(tx, gymId, set, lineId))).toBe(lineId);
    expect((await linkedSnapshots(set)).map((r: any) => Number(r.source_id))).toEqual([lineId]);
  });

  it('answers null for a line the set does not link', async () => {
    const { lineId } = await sharedLine();
    const unrelated = await draftSet(await member());
    expect(await db.transaction((tx) => ownRecurringLine(tx, gymId, unrelated, lineId))).toBeNull();
  });

  it('copies a shared line for the set, re-points the set\'s link and leaves the other set\'s line alone', async () => {
    const { creatorSet, otherSet, lineId, snapshotId } = await sharedLine();
    const owned = await db.transaction((tx) => ownRecurringLine(tx, gymId, otherSet, lineId));
    expect(owned).not.toBe(lineId);
    const mine = await linkedSnapshots(otherSet);
    expect(mine).toHaveLength(1);
    expect(Number(mine[0].source_id)).toBe(owned);
    expect(Number(mine[0].line_ref)).toBe(lineId);
    const theirs = await linkedSnapshots(creatorSet);
    expect(theirs.map((r: any) => Number(r.id))).toEqual([snapshotId]);
    const legacy = (await db.query<any>('SELECT product_set_id, line_ref FROM member_products_recurrent_snapshot WHERE id = ?', [owned])).rows[0];
    expect(Number(legacy.product_set_id)).toBe(otherSet);
    expect(Number(legacy.line_ref)).toBe(lineId);
  });

  it('a quantity change on a shared line changes the Draft\'s copy only', async () => {
    const { creatorSet, otherSet, lineId } = await sharedLine();
    const res = await db.transaction(async (tx) => setServiceQuantity(tx, await locked(tx, otherSet), lineId, 4));
    expect(res).toEqual({ ok: true, quantity: 4 });
    expect((await linkedSnapshots(otherSet)).map((r: any) => Number(r.quantity))).toEqual([4]);
    expect((await linkedSnapshots(creatorSet)).map((r: any) => Number(r.quantity))).toEqual([1]);
    const original = (await db.query<any>('SELECT quantity FROM member_products_recurrent_snapshot WHERE id = ?', [lineId])).rows[0];
    expect(Number(original.quantity)).toBe(1);
  });

  it('removing a shared line from a Draft removes it from that Draft only', async () => {
    const { creatorSet, otherSet, lineId, snapshotId } = await sharedLine();
    const res = await db.transaction(async (tx) => removeService(tx, await locked(tx, otherSet), lineId));
    expect(res).toMatchObject({ ok: true, deleted: true });
    expect(await linkedSnapshots(otherSet)).toHaveLength(0);
    expect((await linkedSnapshots(creatorSet)).map((r: any) => Number(r.id))).toEqual([snapshotId]);
    const original = (await db.query<any>('SELECT id FROM member_products_recurrent_snapshot WHERE id = ?', [lineId])).rows;
    expect(original).toHaveLength(1);
  });
});
