import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { productSetLegacyAssignmentIdSql } from '../domain/planAssignments';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym, legacyChildQuery } from './helpers';
import { createDraft, addCoverage, cancelInFlight } from '../api/product-sets';
import { activateWithEvents, snapshotProductSetFromPlan } from '../api/product-set-configuration';
import { ensureRecurringDraft } from '../api/recurring-purchase-draft';
import { applyPromotionToProductSet, fetchAppliedPromotions } from '../api/membership-promotions';

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
    await addCoverage(tx, { gymId, productSetId: d.productSet.id, memberId: owner, isOwner: true });
    const out = await activateWithEvents(tx, { gymId, productSetId: d.productSet.id, today: TODAY });
    if (out.kind !== 'ok') throw new Error(out.kind);
    return d.productSet.id;
  });
}
async function assignmentOf(setId: number): Promise<number> {
  const { rows } = await db.query<any>(`SELECT ${productSetLegacyAssignmentIdSql('product_sets')} AS user_membership_id FROM product_sets WHERE id = ?`, [setId]);
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
    // #3026 stage 3d-1: the application is the plan snapshot's own row.
    const planApplications = async (setId: number) => (await legacyChildQuery(
      'SELECT id, status FROM user_membership_promotions WHERE product_set_id = ?', [setId])).rows;
    expect((await planApplications(v1)).length).toBeGreaterThan(0);

    const draft = await draftFrom(owner);
    const heldByDraft = await rowsHeldBy(draft);
    // The plan the Draft leaves unchanged is the Active version's own snapshot, linked rather than
    // copied (#2125 M4b-3), and its applications are that snapshot's rows: the Draft reads the very
    // same ones and holds no copy.
    expect(heldByDraft['plan_snapshots']).toBeUndefined();
    expect((await planApplications(draft)).map((a: any) => a.id)).toEqual((await planApplications(v1)).map((a: any) => a.id));
    const { rows: links } = await db.query<any>(
      `SELECT j.plan_snapshot_id FROM product_set_plan_snapshots j WHERE j.product_set_id IN (?, ?) ORDER BY j.product_set_id`, [v1, draft]);
    expect(links).toHaveLength(2);
    expect(Number(links[0].plan_snapshot_id)).toBe(Number(links[1].plan_snapshot_id));
    expect(await statusOf('product_sets', draft)).toBe('in_cart');

    await db.transaction(async (tx) => {
      expect((await cancelInFlight(tx, gymId, draft)).kind).toBe('cancelled');
    });

    expect(await rowsHeldBy(draft)).toEqual({});
    const { rows: gone } = await db.query<any>('SELECT id FROM product_sets WHERE id = ?', [draft]);
    expect(gone).toHaveLength(0);
    // The shared plan snapshot survives the discard, still the Active version's.
    const { rows: kept } = await db.query<any>(
      'SELECT COUNT(*) AS n FROM product_set_plan_snapshots WHERE product_set_id = ?', [v1]);
    expect(Number(kept[0].n)).toBe(1);
    // The Active version, its assignment and its application are exactly as they were.
    expect(await statusOf('product_sets', v1)).toBe('active');
    expect(await statusOf('user_memberships', umV1)).toBe('active');
    expect(await rowsHeldBy(v1)).toEqual(heldByV1);
    expect(await names(umV1)).toEqual([promo]);
    const { rows: stray } = await db.query<any>(
      `SELECT id FROM user_memberships WHERE gym_id = ? AND member_id = ? AND status IN ('in_cart', 'pending_payment')`, [gymId, owner]);
    expect(stray).toHaveLength(0);
  });

  it('a successful payment activates the new version and supersedes the previous one with its history kept (an unchanged plan keeps its assignment, M4b-3)', async () => {
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
    // ...the plan was not changed, so its assignment is the same one, still active (#2125 M4b-3)...
    expect(umV2).toBe(umV1);
    // ...and the previous version is superseded, never deleted, still readable. The plan was not
    // changed, so both versions link one plan snapshot and its application stands on it (#3026).
    expect(await statusOf('product_sets', v1)).toBe('superseded');
    const { rows: apps } = await legacyChildQuery(
      'SELECT status, user_membership_id FROM user_membership_promotions WHERE product_set_id = ?', [v1]);
    expect(apps.map((a: any) => [a.status, a.user_membership_id])).toEqual([['applied', umV1]]);
    expect((await rowsHeldBy(v1))['product_set_plan_snapshots']).toBeGreaterThan(0);
    const { rows: shared } = await db.query<any>(
      'SELECT COUNT(DISTINCT plan_snapshot_id) AS n FROM product_set_plan_snapshots WHERE product_set_id IN (?, ?)', [v1, draft]);
    expect(Number(shared[0].n)).toBe(1);
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
