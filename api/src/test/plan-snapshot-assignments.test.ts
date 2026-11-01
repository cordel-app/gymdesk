import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym } from './helpers';
import { createDraft } from '../api/product-sets';
import { applyPromotionToProductSet } from '../api/membership-promotions';
import {
  activateWithEvents, addProductSetService, ensureSchedule, loadProductSetSimulationAssignment,
  materialiseScheduledEvents, snapshotProductSetFromPlan,
} from '../api/product-set-configuration';
import { allocateSchedule, cadenceForFrequency } from '../domain/scheduleAllocation';
import { computeBillingSimulation } from '../domain/billingSimulation';
import { loadProductSetSimulationAssignments } from '../api/plan-snapshot-assignments';

let gymId: string;
const actor = { name: 'Test', type: 'staff' };
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}`;
const day = (offset: number) => {
  const d = new Date(); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10);
};
const TODAY = day(0);

async function member(): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'M', `pse-${uniq()}@example.com`]);
  return insertId;
}
async function product(name: string, amount: number, billingFrequency: string, type = 'fee'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, amount, currency, billing_frequency, status, availability, is_system)
     VALUES (?, ?, ?, ?, 'EUR', ?, 'active', 'available', 0)`,
    [gymId, `${name}-${uniq()}`, type, amount, billingFrequency]);
  return insertId;
}
async function plan(opts: { price: number; free?: number | null; periodical?: Array<{ productId: number }> }): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit,
        free_periods, paid_periods, bonus_periods, pay_beforehand_periods)
     VALUES (?, ?, 'active', 'public', '1', ?, NULL, 0, 0)`,
    [gymId, `PSE-Plan-${uniq()}`, opts.free ?? null]);
  await db.query(
    `INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
     VALUES (?, ?, ?, ?, 'active')`, [gymId, insertId, opts.price, day(-365)]);
  await db.query(
    `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  for (const p of opts.periodical ?? []) {
    await db.query(
      `INSERT INTO membership_plan_periodical (gym_id, membership_plan_id, product_id, quantity) VALUES (?, ?, ?, 1)`,
      [gymId, insertId, p.productId]);
  }
  return insertId;
}

async function newVersion(owner: number, planId: number | null, startsAt = TODAY, fee: number | null = null) {
  return db.transaction(async (tx) => {
    const d = await createDraft(tx, { gymId, ownerMemberId: owner, membershipPlanId: planId, startsAt, actor });
    if (d.kind !== 'created') throw new Error(`expected created, got ${d.kind}`);
    if (planId != null) {
      await snapshotProductSetFromPlan(tx, { gymId, productSetId: d.productSet.id, membershipPlanId: planId, membershipFeePrice: fee, startsAt });
    }
    return d.productSet;
  });
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);

async function scheduledEvents(setId: number) {
  const { rows } = await db.query<any>(
    `SELECT id, schedule_id, period_start, billing_date, amount FROM billing_events
      WHERE product_set_id = ? AND is_scheduled = 1 ORDER BY billing_date, id`, [setId]);
  return rows.map((r: any) => ({ ...r, period_start: iso(r.period_start), billing_date: iso(r.billing_date) }));
}

beforeAll(async () => { gymId = await createTestGym('Plan snapshot assignments gym'); });
afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

// #2125 stage 6 — the engine's input is one assignment per plan snapshot of the version.
describe('loadProductSetSimulationAssignments', () => {
  it('with one plan answers exactly what the version-keyed loader builds', async () => {
    const locker = await product('Locker', 10, 'month');
    const planId = await plan({ price: 50, periodical: [{ productId: locker }] });
    const set = await newVersion(await member(), planId, TODAY, 50);
    const legacy = await loadProductSetSimulationAssignment(gymId, set.id);
    const list = await loadProductSetSimulationAssignments(gymId, set.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual(legacy);
  });

  it('a plan-less version answers the version-keyed assignment', async () => {
    const set = await newVersion(await member(), null);
    const list = await loadProductSetSimulationAssignments(gymId, set.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual(await loadProductSetSimulationAssignment(gymId, set.id));
  });

  it('with two plan snapshots the engine bills both fees and the first plan is untouched', async () => {
    const locker = await product('Locker2', 10, 'month');
    const first = await plan({ price: 50, periodical: [{ productId: locker }] });
    const second = await plan({ price: 30 });
    const owner = await member();
    const set = await newVersion(owner, first, TODAY, 50);
    const before = await loadProductSetSimulationAssignments(gymId, set.id);

    const { rows: snap } = await db.query<any>(
      'SELECT schedule_id FROM plan_snapshots WHERE product_set_id = ?', [set.id]);
    await db.query(
      `INSERT INTO plan_snapshots
         (gym_id, product_set_id, member_id, membership_plan_id, status, starts_at, schedule_id,
          membership_fee_price, recurring_billing_interval, recurring_billing_unit, auto_renew)
       VALUES (?, ?, ?, ?, 'draft', ?, ?, 30, 1, 'month', 0)`,
      [gymId, set.id, owner, second, TODAY, snap[0].schedule_id]);

    const list = await loadProductSetSimulationAssignments(gymId, set.id);
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual(before[0]);
    expect(list[1].membershipFeePrice).toBe(30);
    expect(list[1].services).toEqual([]);

    const one = computeBillingSimulation({ assignments: [list[0]] });
    const both = computeBillingSimulation({ assignments: list });
    expect(both.available).toBe(true);
    const firstDate = (r: typeof one) => r.sections.flatMap((s) => s.events).sort((a, b) => (a.date < b.date ? -1 : 1))[0];
    expect(firstDate(both).total).toBe(Math.round((firstDate(one).total + 30) * 100) / 100);
  });
});

async function planPromotion(planId: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status, stackable,
                             only_applicable_for_new_members, paid_months, applies_to)
     VALUES (?, ?, '2020-01-01', '2099-12-31', 'active', 1, 0, 12, 'membership_plan')`, [gymId, `Promo-${uniq()}`]);
  await db.query('INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)',
    [gymId, insertId, planId]);
  await db.query(
    `INSERT INTO promotion_membership_fee_benefits (gym_id, promotion_id, duration_months, enabled, action, value)
     VALUES (?, ?, NULL, 1, 'percentage_discount', 10)`, [gymId, insertId]);
  return Number(insertId);
}

describe('a plan Promotion belongs to its plan snapshot', () => {
  it('is read from the snapshot and matches the version-keyed loader on a Draft', async () => {
    const planId = await plan({ price: 50 });
    const promo = await planPromotion(planId);
    const set = await newVersion(await member(), planId, TODAY, 50);
    await db.transaction((tx) => applyPromotionToProductSet(tx, gymId, 'T', set.id, promo));
    const legacy = await loadProductSetSimulationAssignment(gymId, set.id);
    const list = await loadProductSetSimulationAssignments(gymId, set.id);
    expect(list[0].promotions).toHaveLength(1);
    expect(list[0].promotions[0].membershipFeeBenefits[0]).toMatchObject({ action: 'percentage_discount', value: 10 });
    expect(list[0]).toEqual(legacy);
  });
});
