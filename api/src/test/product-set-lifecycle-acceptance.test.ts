import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym } from './helpers';
import { createDraft, addCoverage, cancelInFlight } from '../api/product-sets';
import { activateWithEvents, snapshotProductSetFromPlan } from '../api/product-set-configuration';
import { ensureRecurringDraft } from '../api/recurring-purchase-draft';
import { applyPromotionToProductSet, fetchAppliedPromotions } from '../api/membership-promotions';
import { revokePromotionMutator } from '../api/product-set-bridge';

let gymId: string;
let planId: number;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}`;
const TODAY = new Date().toISOString().slice(0, 10);
const actor = { name: 'T', type: 'staff' };

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'M', `own-${uniq()}@example.com`]);
  return insertId;
}
async function promotion(appliesTo: 'membership_plan' | 'product' = 'membership_plan', productId?: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status, stackable,
                             only_applicable_for_new_members, paid_months, applies_to)
     VALUES (?, ?, '2020-01-01', '2099-12-31', 'active', 1, 0, 12, ?)`, [gymId, `Promo-${uniq()}`, appliesTo]);
  if (appliesTo === 'membership_plan') {
    await db.query('INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)',
      [gymId, insertId, planId]);
    await db.query(
      `INSERT INTO promotion_membership_fee_benefits (gym_id, promotion_id, duration_months, enabled, action, value)
       VALUES (?, ?, NULL, 1, 'percentage_discount', 10)`, [gymId, insertId]);
  } else {
    await db.query(
      `INSERT INTO promotion_oneoff (gym_id, promotion_id, product_id, quantity) VALUES (?, ?, ?, 1)`,
      [gymId, insertId, productId]);
  }
  return Number(insertId);
}
/** Commits a Draft carrying `promotionIds` as a new version, returning its set id. */
async function commit(owner: number, promotionIds: number[]): Promise<number> {
  return db.transaction(async (tx) => {
    const d = await createDraft(tx, { gymId, ownerMemberId: owner, membershipPlanId: planId, startsAt: TODAY, actor });
    if (d.kind !== 'created') throw new Error(d.kind);
    await snapshotProductSetFromPlan(tx, { gymId, productSetId: d.productSet.id, membershipPlanId: planId, membershipFeePrice: 30, startsAt: TODAY });
    for (const p of promotionIds) await applyPromotionToProductSet(tx, gymId, 'T', d.productSet.id, p);
    await addCoverage(tx, { gymId, rootProductSetId: Number(d.productSet.root_product_set_id), memberId: owner, isOwner: true });
    const out = await activateWithEvents(tx, { gymId, productSetId: d.productSet.id, today: TODAY });
    if (out.kind !== 'ok') throw new Error(out.kind);
    return d.productSet.id;
  });
}
async function assignmentOf(setId: number): Promise<number> {
  const { rows } = await db.query<any>('SELECT user_membership_id FROM product_sets WHERE id = ?', [setId]);
  return Number(rows[0].user_membership_id);
}
const names = async (umId: number) => (await fetchAppliedPromotions(gymId, umId)).filter((a: any) => a.status === 'applied').map((a: any) => a.promotion_id);
async function draftFrom(owner: number): Promise<number> {
  return db.transaction(async (tx) => {
    const out = await ensureRecurringDraft(tx, { gymId, memberId: owner, actor, today: TODAY });
    if (out.kind !== 'ok') throw new Error(out.kind);
    return out.productSetId;
  });
}

beforeAll(async () => {
  gymId = await createTestGym('Lifecycle acceptance gym');
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', '1')`, [gymId, `Own-${uniq()}`]);
  planId = Number(insertId);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, 30, '2020-01-01', 'active')`, [gymId, planId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, planId]);
});
afterAll(async () => {
  await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});


/** Every table that carries a `product_set_id`, with the rows a set holds in each. */
async function rowsHeldBy(setId: number): Promise<Record<string, number>> {
  const { rows: tables } = await db.query<any>(
    `SELECT DISTINCT TABLE_NAME AS t FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'product_set_id'
        AND TABLE_NAME IN (SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE')`);
  const out: Record<string, number> = {};
  for (const { t } of tables) {
    const { rows } = await db.query<any>(`SELECT COUNT(*) AS n FROM \`${t}\` WHERE product_set_id = ?`, [setId]);
    const n = Number(rows[0].n);
    if (n > 0) out[t] = n;
  }
  return out;
}
const statusOf = async (table: string, id: number) =>
  (await db.query<any>(`SELECT status FROM ${table} WHERE id = ?`, [id])).rows[0]?.status;

describe('ProductSet snapshot lifecycle (#1991 acceptance)', () => {
  it('editing a Draft never touches the Active version, and discarding it hard-deletes everything the Draft owns', async () => {
    const owner = await member();
    const promo = await promotion();
    const v1 = await commit(owner, [promo]);
    const umV1 = await assignmentOf(v1);
    const heldByV1 = await rowsHeldBy(v1);
    expect(heldByV1['user_membership_promotions']).toBeGreaterThan(0);

    const draft = await draftFrom(owner);
    const heldByDraft = await rowsHeldBy(draft);
    // The Draft is a complete, independent copy: plan snapshot and application included.
    expect(heldByDraft['product_set_plan_snapshots']).toBeGreaterThan(0);
    expect(heldByDraft['user_membership_promotions']).toBeGreaterThan(0);
    expect(await statusOf('product_sets', draft)).toBe('draft');

    await db.transaction(async (tx) => {
      expect((await cancelInFlight(tx, gymId, draft)).kind).toBe('cancelled');
    });

    expect(await rowsHeldBy(draft)).toEqual({});
    const { rows: gone } = await db.query<any>('SELECT id FROM product_sets WHERE id = ?', [draft]);
    expect(gone).toHaveLength(0);
    // The Active version, its assignment and its application are exactly as they were.
    expect(await statusOf('product_sets', v1)).toBe('active');
    expect(await statusOf('user_memberships', umV1)).toBe('active');
    expect(await rowsHeldBy(v1)).toEqual(heldByV1);
    expect(await names(umV1)).toEqual([promo]);
    const { rows: stray } = await db.query<any>(
      `SELECT id FROM user_memberships WHERE gym_id = ? AND member_id = ? AND status IN ('draft', 'pending_payment')`, [gymId, owner]);
    expect(stray).toHaveLength(0);
  });

  it('a successful payment activates the new version and supersedes the previous one with its history kept', async () => {
    const owner = await member();
    const promo = await promotion();
    const v1 = await commit(owner, [promo]);
    const umV1 = await assignmentOf(v1);
    const { rows: dueBefore } = await db.query<any>(
      'SELECT id FROM billing_events WHERE product_set_id = ? AND (billing_date IS NULL OR billing_date <= ?) ORDER BY id', [v1, TODAY]);
    expect(dueBefore.length).toBeGreaterThan(0);

    const draft = await draftFrom(owner);
    await db.transaction(async (tx) => {
      const out = await activateWithEvents(tx, { gymId, productSetId: draft, today: TODAY });
      if (out.kind !== 'ok') throw new Error(out.kind);
    });
    const umV2 = await assignmentOf(draft);

    // New configuration is the source of truth...
    expect(await statusOf('product_sets', draft)).toBe('active');
    expect(await statusOf('user_memberships', umV2)).toBe('active');
    expect(await names(umV2)).toEqual([promo]);
    // ...and the previous one is superseded, never deleted, still readable.
    expect(await statusOf('product_sets', v1)).toBe('superseded');
    expect(await statusOf('user_memberships', umV1)).toBe('superseded');
    const { rows: apps } = await db.query<any>('SELECT status FROM user_membership_promotions WHERE user_membership_id = ?', [umV1]);
    expect(apps.map((a: any) => a.status)).toEqual(['superseded']);
    expect((await rowsHeldBy(v1))['product_set_plan_snapshots']).toBeGreaterThan(0);
    // Billing history of the previous version that was already due is kept.
    const { rows: dueAfter } = await db.query<any>(
      'SELECT id FROM billing_events WHERE product_set_id = ? AND (billing_date IS NULL OR billing_date <= ?) ORDER BY id', [v1, TODAY]);
    expect(dueAfter.map((r: any) => Number(r.id))).toEqual(dueBefore.map((r: any) => Number(r.id)));
    // Only one Active version per owner.
    const { rows: active } = await db.query<any>(
      `SELECT COUNT(*) AS n FROM product_sets WHERE owner_member_id = ? AND status = 'active'`, [owner]);
    expect(Number(active[0].n)).toBe(1);
  });
});
