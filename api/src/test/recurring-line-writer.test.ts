// #2126 stage 5c — a recurring Product line is written by one writer, into its Product snapshot;
// nothing re-derives the snapshot from the legacy line. Since stage 5d-6 the legacy line table
// (`member_products_recurrent_snapshot`) is dropped (migration 415).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym } from './helpers';
import { createDraft } from '../api/product-sets';
import { snapshotProductSetFromPlan } from '../api/product-set-configuration';
import {
  copyRecurringLines, deleteRecurringLine, insertRecurringLine, updateRecurringLine,
} from '../api/recurring-line-writer';
import { syncProductSnapshotsOfVersion } from '../api/product-snapshot-sync';

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}`;
const TODAY = new Date().toISOString().slice(0, 10);
const actor = { name: 'T', type: 'staff' };

beforeAll(async () => { gymId = await createTestGym('Recurring line writer gym'); });
afterAll(async () => { await cleanupTestGyms(); await db.end(); });

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'M', `rlw-${uniq()}@example.com`]);
  return insertId;
}
async function plan(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', '2')`, [gymId, `RLW-${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, 20, '2020-01-01', 'active')`, [gymId, insertId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return Number(insertId);
}
async function product(name: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, amount, status, is_system, currency)
     VALUES (?, ?, 'service', 'month', 12.50, 'active', 0, 'EUR')`, [gymId, name]);
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
const snapshot = async (sourceId: number) =>
  (await db.query<any>('SELECT * FROM product_periodical_snapshots WHERE source_id = ?', [sourceId])).rows[0];
const linked = async (setId: number) =>
  (await db.query<any>(
    `SELECT s.source_id FROM product_set_periodical_snapshots j JOIN product_periodical_snapshots s ON s.id = j.product_periodical_snapshot_id
      WHERE j.product_set_id = ? ORDER BY s.source_id`, [setId])).rows.map((r: any) => Number(r.source_id));

describe('recurring line writer (#2126 stage 5c)', () => {
  it('writes, changes, copies and deletes the line on its snapshot alone', async () => {
    const owner = await member();
    const setId = await draftSet(owner);
    const productId = await product(`Locker-${uniq()}`);

    const lineId = await db.transaction((tx) => insertRecurringLine(tx, {
      gymId, productSetId: setId, productId, quantity: 2, startsAt: TODAY, origin: 'admin', assignedMemberId: owner,
    }));
    expect(lineId).not.toBeNull();
    let snap = await snapshot(lineId!);
    expect(Number(snap.line_ref)).toBe(lineId);
    expect(snap.product_name).toMatch(/^Locker-/);
    expect(snap.product_type).toBe('service');
    expect(snap.billing_frequency).toBe('month');
    expect(snap.unit_price).toBe('12.50');
    expect(Number(snap.quantity)).toBe(2);
    expect(snap.origin).toBe('admin');
    expect(Number(snap.assigned_member_id)).toBe(owner);
    expect(Number(snap.product_set_id)).toBe(setId);
    expect(snap.status).toBe('draft');
    expect(Number(snap.member_id)).toBe(owner);
    expect(await linked(setId)).toEqual([lineId]);

    await db.transaction((tx) => updateRecurringLine(tx, gymId, lineId!, {
      quantity: 3, list_unit_price: '12.50', direct_discount_percent: '20.00', unit_price: '10.00',
    }));
    snap = await snapshot(lineId!);
    expect(Number(snap.quantity)).toBe(3);
    expect(snap.unit_price).toBe('10.00');
    expect(snap.list_price).toBe('12.50');
    expect(snap.direct_discount_percent).toBe('20.00');
    expect(snap.modified_at).not.toBeNull();

    // A new version takes the lines as inherited copies, with their own ids and snapshots.
    const nextSet = await draftSet(await member());
    const copies = await db.transaction((tx) => copyRecurringLines(tx, gymId, setId, nextSet, { carryAssignee: true }));
    const copyId = copies.get(lineId!)!;
    expect(copyId).toBeGreaterThan(lineId!);
    const copySnap = await snapshot(copyId);
    expect(Number(copySnap.copied_from_periodical_snapshot_id)).toBe(lineId);
    expect(Number(copySnap.line_ref)).toBe(lineId);
    expect(Number(copySnap.product_set_id)).toBe(nextSet);
    expect(Number(copySnap.quantity)).toBe(3);
    expect(copySnap.unit_price).toBe('10.00');
    expect(Number(copySnap.assigned_member_id)).toBe(owner);
    expect(await linked(nextSet)).toEqual([copyId]);

    // A merge into a Draft does not carry who the line is for.
    const mergedSet = await draftSet(await member());
    const merged = await db.transaction((tx) => copyRecurringLines(tx, gymId, setId, mergedSet, { carryAssignee: false }));
    const mergedSnap = await snapshot(merged.get(lineId!)!);
    expect(mergedSnap.assigned_member_id).toBeNull();
    expect(Number(mergedSnap.line_ref)).toBe(lineId);

    // Deleting removes the snapshot and its link.
    await db.transaction((tx) => deleteRecurringLine(tx, gymId, copyId));
    expect(await snapshot(copyId)).toBeUndefined();
    expect(await linked(nextSet)).toEqual([]);
    // The predecessor's line is untouched.
    expect(Number((await snapshot(lineId!)).quantity)).toBe(3);
  });

  it('a new line and a copy take their id from the snapshot (#2126 stage 5d-2)', async () => {
    const owner = await member();
    const setId = await draftSet(owner);
    const productId = await product(`Id-${uniq()}`);
    const lineId = await db.transaction((tx) => insertRecurringLine(tx, {
      gymId, productSetId: setId, productId, quantity: 1, startsAt: TODAY,
    }));
    const snap = await snapshot(lineId!);
    expect(Number(snap.id)).toBe(lineId);
    expect(Number(snap.source_id)).toBe(lineId);
    expect(Number(snap.line_ref)).toBe(lineId);

    const nextSet = await draftSet(await member());
    const copies = await db.transaction((tx) => copyRecurringLines(tx, gymId, setId, nextSet, { carryAssignee: true }));
    const copyId = copies.get(lineId!)!;
    const copySnap = await snapshot(copyId);
    expect(Number(copySnap.id)).toBe(copyId);
    expect(Number(copySnap.line_ref)).toBe(lineId);

    // The snapshot sequence is the allocator: the next line id follows it, never a historical legacy id.
    const { rows } = await db.query<{ top: number }>(
      'SELECT MAX(id) AS top FROM product_periodical_snapshots');
    const nextId = await db.transaction((tx) => insertRecurringLine(tx, {
      gymId, productSetId: setId, productId, quantity: 1, startsAt: TODAY,
    }));
    expect(nextId!).toBeGreaterThan(Number(rows[0].top));
  });

  it('a line of a Product the gym does not have is not written', async () => {
    const owner = await member();
    const setId = await draftSet(owner);
    const otherGym = await createTestGym('Recurring line writer other gym');
    const { insertId: foreign } = await db.query(
      `INSERT INTO products (gym_id, name, type, billing_frequency, amount, status, is_system, currency)
       VALUES (?, 'Foreign', 'service', 'month', 5, 'active', 0, 'EUR')`, [otherGym]);
    const lineId = await db.transaction((tx) => insertRecurringLine(tx, {
      gymId, productSetId: setId, productId: Number(foreign), quantity: 1, startsAt: TODAY,
    }));
    expect(lineId).toBeNull();
    expect(await linked(setId)).toEqual([]);
  });

  it('the version sync keeps a line snapshot\'s status with the set and writes no legacy line', async () => {
    const owner = await member();
    const setId = await draftSet(owner);
    const productId = await product(`Towel-${uniq()}`);
    const lineId = await db.transaction((tx) => insertRecurringLine(tx, {
      gymId, productSetId: setId, productId, quantity: 1, startsAt: TODAY,
    }));
    await db.query("UPDATE product_sets SET status = 'pending_payment' WHERE id = ?", [setId]);
    await db.transaction((tx) => syncProductSnapshotsOfVersion(tx, gymId, setId));
    const snap = await snapshot(lineId!);
    expect(Number(snap.quantity)).toBe(1);
    expect(snap.status).toBe('pending_payment');
  });
});
