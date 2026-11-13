// #2126 stage 5d-1 — nothing outside the legacy Product tables points at them any more, and the one
// rule only the purchase record enforced (one pending purchase per member and Product) holds on the
// purchase snapshots too (migration 411).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym } from './helpers';
import { createDraft } from '../api/product-sets';
import { snapshotProductSetFromPlan } from '../api/product-set-configuration';
import { deleteRecurringLine, insertRecurringLine } from '../api/recurring-line-writer';
import { insertPurchase, type PurchaseValues } from '../api/purchase-writer';

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}`;
const TODAY = new Date().toISOString().slice(0, 10);
const actor = { name: 'T', type: 'staff' };

beforeAll(async () => { gymId = await createTestGym('Snapshot purchase keys gym'); });
afterAll(async () => { await cleanupTestGyms(); await db.end(); });

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'M', `spk-${uniq()}@example.com`]);
  return Number(insertId);
}
async function product(type: string, frequency: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, amount, status, is_system, currency)
     VALUES (?, ?, ?, ?, 12.50, 'active', 0, 'EUR')`, [gymId, `SPK-${uniq()}`, type, frequency]);
  return Number(insertId);
}
async function draftSet(owner: number): Promise<number> {
  const { insertId: planId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', '1')`, [gymId, `SPK-${uniq()}`]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, planId]);
  return db.transaction(async (tx) => {
    const d = await createDraft(tx, { gymId, ownerMemberId: owner, membershipPlanId: Number(planId), startsAt: TODAY, actor });
    if (d.kind !== 'created') throw new Error(d.kind);
    await snapshotProductSetFromPlan(tx, { gymId, productSetId: d.productSet.id, membershipPlanId: Number(planId), membershipFeePrice: 20, startsAt: TODAY });
    return d.productSet.id;
  });
}
function purchase(memberId: number, productId: number, productType: string, status: string): PurchaseValues {
  return {
    gymId, memberId, productId, status, productName: 'Thing', productType, billingFrequency: 'once',
    units: productType === 'sessions' ? 5 : null, amount: 10, currency: 'EUR', taxRatePercent: null,
    listPrice: null, directDiscountPercent: null, directDiscountAmount: null, validityDays: null,
    origin: 'admin', assignedMemberId: null, createdBy: 'T', paymentRequestId: null, billingEventId: null,
  };
}

describe('migration 411 (#2126 stage 5d-1)', () => {
  it('leaves no foreign key pointing at a legacy Product table outside the three', async () => {
    const { rows } = await db.query<any>(
      `SELECT TABLE_NAME AS t, CONSTRAINT_NAME AS c FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = DATABASE()
          AND REFERENCED_TABLE_NAME IN ('member_products_oneoff_snapshot', 'member_products_recurrent_snapshot',
                                        'member_products_oneoff_promotion_snapshot')
          AND TABLE_NAME NOT IN ('member_products_oneoff_snapshot', 'member_products_recurrent_snapshot',
                                 'member_products_oneoff_promotion_snapshot')`);
    expect(rows).toEqual([]);
  });

  it('a line-owned Promotion application references the line snapshot and goes with it', async () => {
    const owner = await member();
    const setId = await draftSet(owner);
    const productId = await product('service', 'month');
    const lineId = await db.transaction((tx) => insertRecurringLine(tx, {
      gymId, productSetId: setId, productId, quantity: 1, startsAt: TODAY, origin: 'admin', assignedMemberId: owner,
    }));
    const { insertId: promotionId } = await db.query(
      `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status, applies_to)
       VALUES (?, ?, '2026-01-01', '2099-12-31', 'active', 'product')`, [gymId, `P-${uniq()}`]);
    const { insertId: appId } = await db.query(
      `INSERT INTO user_membership_promotions (gym_id, product_set_id, promotion_id, status, recurrent_snapshot_id)
       VALUES (?, ?, ?, 'applied', ?)`, [gymId, setId, promotionId, lineId]);

    // A line id no snapshot carries is refused.
    await expect(db.query(
      `INSERT INTO user_membership_promotions (gym_id, product_set_id, promotion_id, status, recurrent_snapshot_id)
       VALUES (?, ?, ?, 'revoked', ?)`, [gymId, setId, promotionId, 999999999])).rejects.toThrow(/foreign key/i);

    await db.transaction((tx) => deleteRecurringLine(tx, gymId, lineId!));
    const { rows } = await db.query<any>('SELECT id FROM user_membership_promotions WHERE id = ?', [appId]);
    expect(rows).toEqual([]);
  });

  it.each([
    ['service', 'product_oneoff_snapshots'],
    ['sessions', 'product_session_snapshots'],
  ])('one pending %s purchase per member and Product holds on %s', async (type, table) => {
    const m = await member();
    const productId = await product(type, 'once');
    await db.transaction((tx) => insertPurchase(tx, purchase(m, productId, type, 'pending_payment')));
    const second = await db.transaction((tx) => insertPurchase(tx, purchase(m, productId, type, 'active')));
    // The snapshot alone refuses a second pending row, whatever the legacy record says.
    await expect(db.query(
      `UPDATE ${table} SET status = 'pending_payment' WHERE source_id = ?`, [second],
    )).rejects.toThrow(/pending_purchase_key/);
    // Another member, or the same member's settled purchase, is not blocked.
    const other = await member();
    await db.transaction((tx) => insertPurchase(tx, purchase(other, productId, type, 'pending_payment')));
    const { rows } = await db.query<any>(
      `SELECT COUNT(*) AS n FROM ${table} WHERE product_id = ? AND status = 'pending_payment'`, [productId]);
    expect(Number(rows[0].n)).toBe(2);
  });
});
