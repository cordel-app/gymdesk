// #3541 — a recurring Product line keeps the Product's Notes as they were when its snapshot was written:
// `insertRecurringLine()` freezes them from the Product, and a copy (`ownRecurringLine()`, the copy-on-write
// of a shared line) carries its source's Notes rather than reading the Product again. A legacy line written
// before migration 498 holds NULL, and so does its copy: today's Notes are never presented as historical.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym } from './helpers';
import { createDraft } from '../api/product-sets';
import { snapshotProductSetFromPlan } from '../api/product-set-configuration';
import { insertRecurringLine, ownRecurringLine } from '../api/recurring-line-writer';

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}`;
const TODAY = new Date().toISOString().slice(0, 10);
const actor = { name: 'T', type: 'staff' };

beforeAll(async () => { gymId = await createTestGym('Product snapshot notes gym'); });
afterAll(async () => { await cleanupTestGyms(); await db.end(); });

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'M', `psn-${uniq()}@example.com`]);
  return insertId;
}
async function plan(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', '1')`, [gymId, `PSN-${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, 20, '2020-01-01', 'active')`, [gymId, insertId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return Number(insertId);
}
async function product(notes: string | null): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, amount, status, is_system, currency, notes)
     VALUES (?, ?, 'service', 'month', 12.50, 'active', 0, 'EUR', ?)`, [gymId, `Locker ${uniq()}`, notes]);
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
const notesOf = async (lineId: number) => (await db.query<any>(
  'SELECT notes FROM product_periodical_snapshots WHERE source_id = ? AND gym_id = ?', [lineId, gymId])).rows[0].notes;

/** A line written onto one set and also linked by a second one, so the second set's edit copies it. */
async function sharedLine(productId: number) {
  const creatorSet = await draftSet(await member());
  const otherSet = await draftSet(await member());
  const lineId = Number(await db.transaction((tx) =>
    insertRecurringLine(tx, { gymId, productSetId: creatorSet, productId, quantity: 1, startsAt: TODAY })));
  const snapshotId = Number((await db.query<any>(
    'SELECT id FROM product_periodical_snapshots WHERE source_id = ?', [lineId])).rows[0].id);
  await db.query('INSERT INTO product_set_periodical_snapshots (product_set_id, product_periodical_snapshot_id) VALUES (?, ?)',
    [otherSet, snapshotId]);
  return { otherSet, lineId, snapshotId };
}

describe('a recurring line\'s Notes (#3541)', () => {
  it('freezes the Product\'s Notes, preserving their formatting, when the line is written', async () => {
    const notes = 'Bring a padlock.\n  - Key at reception';
    const productId = await product(notes);
    const set = await draftSet(await member());
    const lineId = Number(await db.transaction((tx) =>
      insertRecurringLine(tx, { gymId, productSetId: set, productId, quantity: 1, startsAt: TODAY })));
    expect(await notesOf(lineId)).toBe(notes);

    // A later edit of the Product moves nothing on the line.
    await db.query('UPDATE products SET notes = ? WHERE id = ?', ['Edited later', productId]);
    expect(await notesOf(lineId)).toBe(notes);
  });

  it('stores NULL for a Product with no Notes', async () => {
    const productId = await product(null);
    const set = await draftSet(await member());
    const lineId = Number(await db.transaction((tx) =>
      insertRecurringLine(tx, { gymId, productSetId: set, productId, quantity: 1, startsAt: TODAY })));
    expect(await notesOf(lineId)).toBeNull();
  });

  it('a copy of a shared line keeps its source\'s Notes, not the Product\'s current ones', async () => {
    const productId = await product('Original notes');
    const { otherSet, lineId } = await sharedLine(productId);
    await db.query('UPDATE products SET notes = ? WHERE id = ?', ['Changed after the line was bought', productId]);
    const copyId = Number(await db.transaction((tx) => ownRecurringLine(tx, gymId, otherSet, lineId)));
    expect(copyId).not.toBe(lineId);
    expect(await notesOf(copyId)).toBe('Original notes');
  });

  it('a copy of a legacy line (no Notes stored) stays NULL rather than taking today\'s Notes', async () => {
    const productId = await product('Notes the legacy line never had');
    const { otherSet, lineId, snapshotId } = await sharedLine(productId);
    await db.query('UPDATE product_periodical_snapshots SET notes = NULL WHERE id = ?', [snapshotId]);
    const copyId = Number(await db.transaction((tx) => ownRecurringLine(tx, gymId, otherSet, lineId)));
    expect(await notesOf(copyId)).toBeNull();
  });
});
