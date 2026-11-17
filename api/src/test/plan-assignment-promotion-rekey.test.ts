import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { productSetLegacyAssignmentIdSql } from '../domain/planAssignments';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym } from './helpers';
import { createDraft, addCoverage } from '../api/product-sets';
import { activateWithEvents, snapshotProductSetFromPlan } from '../api/product-set-configuration';
import { ensureRecurringDraft } from '../api/recurring-purchase-draft';
import { applyPromotionToProductSet } from '../api/membership-promotions';
import { findPlanAssignmentDrift } from '../api/plan-assignment-drift';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { backfillPromotionAssignmentIds } = require('../infra/migrations/430_promotion_assignment_id.js');

let gymId: string;
let planId: number;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}`;
const TODAY = new Date().toISOString().slice(0, 10);
const actor = { name: 'T', type: 'staff' };

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'M', `rekey-${uniq()}@example.com`]);
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
async function draftFrom(owner: number): Promise<number> {
  return db.transaction(async (tx) => {
    const out = await ensureRecurringDraft(tx, { gymId, memberId: owner, actor, today: TODAY });
    if (out.kind !== 'ok') throw new Error(out.kind);
    return out.productSetId;
  });
}

beforeAll(async () => {
  gymId = await createTestGym('Promotion re-key gym');
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', '1')`, [gymId, `Rekey-${uniq()}`]);
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

/** The anchor `stampAssignmentIds()` gives an assignment: the lowest snapshot id naming it. */
async function anchorOf(um: number): Promise<number> {
  const { rows } = await db.query<any>(
    'SELECT MIN(id) AS a FROM plan_snapshots WHERE gym_id = ? AND source_user_membership_id = ?', [gymId, um]);
  return Number(rows[0].a);
}
async function keysOf(setId: number) {
  const { rows } = await db.query<any>(
    'SELECT promotion_id, user_membership_id, assignment_id FROM user_membership_promotions WHERE product_set_id = ? ORDER BY id', [setId]);
  return rows.map((r: any) => ({
    promotion: Number(r.promotion_id),
    um: r.user_membership_id == null ? null : Number(r.user_membership_id),
    assignment: r.assignment_id == null ? null : Number(r.assignment_id),
  }));
}
async function promotionDrift() {
  const report = await findPlanAssignmentDrift(db as any, gymId);
  return report.checks.find((c) => c.name === 'promotion_assignment_mismatch')!;
}

describe('#2125 M6b-33: an application carries its assignment_id beside user_membership_id', () => {
  it('a committed Plan Promotion application takes its assignment\'s anchor', async () => {
    const owner = await member();
    const promo = await promotion();
    const setId = await commit(owner, [promo]);
    const um = await assignmentOf(setId);
    const anchor = await anchorOf(um);
    expect(await keysOf(setId)).toEqual([{ promotion: promo, um, assignment: anchor }]);
    const { rows } = await db.query<any>('SELECT assignment_id FROM plan_snapshots WHERE id = ?', [anchor]);
    expect(Number(rows[0].assignment_id)).toBe(anchor);
  });

  it('a successor Draft\'s copy has neither key; at activation it takes the assignment and the predecessor\'s copy loses both', async () => {
    const owner = await member();
    const promo = await promotion();
    const v1 = await commit(owner, [promo]);
    const um = await assignmentOf(v1);
    const anchor = await anchorOf(um);
    const draftId = await draftFrom(owner);
    expect(await keysOf(draftId)).toEqual([{ promotion: promo, um: null, assignment: null }]);
    await db.transaction(async (tx) => {
      const out = await activateWithEvents(tx, { gymId, productSetId: draftId, today: TODAY });
      if (out.kind !== 'ok') throw new Error(out.kind);
    });
    expect(await assignmentOf(draftId)).toBe(um);
    expect(await keysOf(draftId)).toEqual([{ promotion: promo, um, assignment: anchor }]);
    expect(await keysOf(v1)).toEqual([{ promotion: promo, um: null, assignment: null }]);
  });

  it('a Product-target application has no assignment_id', async () => {
    const owner = await member();
    const { insertId: productId } = await db.query(
      `INSERT INTO products (gym_id, name, type, amount, currency, billing_frequency, status, availability, is_system)
       VALUES (?, ?, 'fee', 10, 'EUR', 'once', 'active', 'available', 0)`, [gymId, `P-${uniq()}`]);
    const productPromo = await promotion('product', Number(productId));
    const setId = await db.transaction(async (tx) => {
      const d = await createDraft(tx, { gymId, ownerMemberId: owner, membershipPlanId: planId, startsAt: TODAY, actor });
      if (d.kind !== 'created') throw new Error(d.kind);
      await snapshotProductSetFromPlan(tx, { gymId, productSetId: d.productSet.id, membershipPlanId: planId, membershipFeePrice: 30, startsAt: TODAY });
      await applyPromotionToProductSet(tx, gymId, 'T', d.productSet.id, productPromo, { productTarget: true });
      await addCoverage(tx, { gymId, productSetId: d.productSet.id, memberId: owner, isOwner: true });
      const out = await activateWithEvents(tx, { gymId, productSetId: d.productSet.id, today: TODAY });
      if (out.kind !== 'ok') throw new Error(out.kind);
      return d.productSet.id;
    });
    expect(await keysOf(setId)).toEqual([{ promotion: productPromo, um: null, assignment: null }]);
  });

  it('plan-assignments:validate reports a drifted application, and the backfill repairs it', async () => {
    expect((await promotionDrift()).count).toBe(0);
    const owner = await member();
    const promo = await promotion();
    const setId = await commit(owner, [promo]);
    const um = await assignmentOf(setId);
    await db.query('UPDATE user_membership_promotions SET assignment_id = NULL WHERE product_set_id = ?', [setId]);
    const drift = await promotionDrift();
    expect(drift.sample.map((r: any) => [Number(r.user_membership_id), r.assignment_id, Number(r.expected_assignment_id)]))
      .toEqual([[um, null, await anchorOf(um)]]);
    await backfillPromotionAssignmentIds({ raw: (sql: string) => db.query(sql) });
    expect((await promotionDrift()).count).toBe(0);
    expect((await keysOf(setId))[0].assignment).toBe(await anchorOf(um));
  });
});
