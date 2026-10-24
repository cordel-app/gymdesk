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
  gymId = await createTestGym('Promo ownership gym');
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

describe('a Membership Plan Promotion application is the assignment\'s (#1995)', () => {
  it('is owned by the assignment it was applied to, with its own grant snapshot', async () => {
    const owner = await member();
    const promo = await promotion();
    const um = await assignmentOf(await commit(owner, [promo]));
    const { rows } = await db.query<any>(
      'SELECT user_membership_id, product_set_id, snapshot FROM user_membership_promotions WHERE user_membership_id = ?', [um]);
    expect(rows.length).toBe(1);
    expect(rows[0].snapshot).toBeTruthy();
    expect(await names(um)).toEqual([promo]);
  });

  it('a successor Draft holds independent copies; editing it leaves the current assignment untouched', async () => {
    const owner = await member();
    const promo = await promotion();
    const um = await assignmentOf(await commit(owner, [promo]));
    const draftId = await draftFrom(owner);
    const { rows: copies } = await db.query<any>(
      'SELECT id, user_membership_id FROM user_membership_promotions WHERE product_set_id = ?', [draftId]);
    expect(copies.length).toBe(1);
    expect(copies[0].user_membership_id).toBeNull(); // belongs to the successor assignment, attached at activation
    await db.transaction(async (tx) => {
      const r = await revokePromotionMutator(promo, 'T')(tx, { id: draftId, gym_id: gymId } as any);
      expect('ok' in r).toBe(true);
    });
    expect(await names(um)).toEqual([promo]);
  });

  it('a cancelled payment leaves the previous assignment intact and a retry does not duplicate snapshots', async () => {
    const owner = await member();
    const promo = await promotion();
    const um = await assignmentOf(await commit(owner, [promo]));
    const first = await draftFrom(owner);
    await db.transaction(async (tx) => { await cancelInFlight(tx, gymId, first); });
    expect(await names(um)).toEqual([promo]);
    const { rows: st } = await db.query<any>('SELECT status FROM user_memberships WHERE id = ?', [um]);
    expect(st[0].status).toBe('active');
    const second = await draftFrom(owner);
    const { rows: copies } = await db.query<any>(
      'SELECT id FROM user_membership_promotions WHERE product_set_id = ?', [second]);
    expect(copies.length).toBe(1);
  });

  it('activation opens a successor assignment that owns its copies and keeps the predecessor\'s as history', async () => {
    const owner = await member();
    const promo = await promotion();
    const umV1 = await assignmentOf(await commit(owner, [promo]));
    const draftId = await draftFrom(owner);
    await db.transaction(async (tx) => {
      const out = await activateWithEvents(tx, { gymId, productSetId: draftId, today: TODAY });
      if (out.kind !== 'ok') throw new Error(out.kind);
    });
    const umV2 = await assignmentOf(draftId);
    expect(umV2).not.toBe(umV1);
    expect(await names(umV2)).toEqual([promo]);
    // #1991: the predecessor and its application are `superseded`, snapshots untouched.
    expect(await names(umV1)).toEqual([]);
    const { rows: kept } = await db.query<any>(
      'SELECT promotion_id, status, snapshot IS NOT NULL AS has_snapshot FROM user_membership_promotions WHERE user_membership_id = ?', [umV1]);
    expect(kept.map((r: any) => [Number(r.promotion_id), r.status, Number(r.has_snapshot)])).toEqual([[promo, 'superseded', 1]]);
    const { rows } = await db.query<any>('SELECT status FROM user_memberships WHERE id = ?', [umV1]);
    expect(rows[0].status).toBe('superseded');
    const { rows: ids } = await db.query<any>(
      'SELECT COUNT(DISTINCT id) AS n FROM user_membership_promotions WHERE user_membership_id IN (?, ?)', [umV1, umV2]);
    expect(Number(ids[0].n)).toBe(2);
  });

  it('keeps the agreed terms when the catalogue Promotion is later edited or soft-deleted', async () => {
    const owner = await member();
    const promo = await promotion();
    const um = await assignmentOf(await commit(owner, [promo]));
    await db.query("UPDATE promotions SET name = 'Renamed', lifecycle_status = 'inactive', deleted_at = UTC_TIMESTAMP() WHERE id = ?", [promo]);
    const apps = await fetchAppliedPromotions(gymId, um);
    expect(apps.length).toBe(1);
    expect(apps[0].snapshot?.name ?? apps[0].promotion_name).toMatch(/^Promo-/);
  });

  it('a Product-target application stays keyed by the version and never joins a plan assignment', async () => {
    const owner = await member();
    const { insertId: productId } = await db.query(
      `INSERT INTO products (gym_id, name, type, amount, currency, billing_frequency, status, availability, is_system)
       VALUES (?, ?, 'fee', 10, 'EUR', 'once', 'active', 'available', 0)`, [gymId, `P-${uniq()}`]);
    const productPromo = await promotion('product', Number(productId));
    const planPromo = await promotion();
    const setId = await db.transaction(async (tx) => {
      const d = await createDraft(tx, { gymId, ownerMemberId: owner, membershipPlanId: planId, startsAt: TODAY, actor });
      if (d.kind !== 'created') throw new Error(d.kind);
      await snapshotProductSetFromPlan(tx, { gymId, productSetId: d.productSet.id, membershipPlanId: planId, membershipFeePrice: 30, startsAt: TODAY });
      await applyPromotionToProductSet(tx, gymId, 'T', d.productSet.id, planPromo);
      await applyPromotionToProductSet(tx, gymId, 'T', d.productSet.id, productPromo, { productTarget: true });
      await addCoverage(tx, { gymId, rootProductSetId: Number(d.productSet.root_product_set_id), memberId: owner, isOwner: true });
      const out = await activateWithEvents(tx, { gymId, productSetId: d.productSet.id, today: TODAY });
      if (out.kind !== 'ok') throw new Error(out.kind);
      return d.productSet.id;
    });
    const um = await assignmentOf(setId);
    expect(await names(um)).toEqual([planPromo]);
    const { rows } = await db.query<any>(
      'SELECT user_membership_id FROM user_membership_promotions WHERE product_set_id = ? AND promotion_id = ?', [setId, productPromo]);
    expect(rows.length).toBe(1);
    expect(rows[0].user_membership_id).toBeNull();
  });
});
