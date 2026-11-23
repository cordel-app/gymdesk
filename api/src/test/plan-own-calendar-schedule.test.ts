import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym } from './helpers';
import { addCoverage, createDraft } from '../api/product-sets';
import {
  activateWithEvents, planScheduledEvents, snapshotProductSetFromPlan,
} from '../api/product-set-configuration';
import { ensureRecurringDraft } from '../api/recurring-purchase-draft';
import { addPlanSnapshotToVersion } from '../api/plan-snapshot-add';
import { advanceBillingDate } from '../domain/billingDate';
import { calendarAnchorOnOrBefore, isOnCalendarGrid } from '../domain/calendarSchedule';
import { daysBetween, daysInMonthOf } from '../domain/proration';

// #3280 — a Membership Plan added to a Member who already bills on an off-calendar schedule (a
// plan opened on the 7th before #2125 M5c) follows its own cadence's calendar: a monthly plan is
// prorated to the next 1st over the real length of its month, a 4-weekly Product it includes to the
// 28-day grid from 2026-11-02, and the established plan keeps its schedule and its Billing Events.
// Integration against real MySQL.

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}`;
const day = (offset: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };
const TODAY = day(0);
const MONTH = { interval: 1, unit: 'month' } as const;
const FOUR_WEEKS = { interval: 4, unit: 'week' } as const;
const actor = { name: 'T', type: 'staff' };
/** A start that is neither the 1st nor a 4-week grid date, so both stretches are prorated. */
const JOIN_START = (() => {
  for (let n = 10; ; n += 1) {
    const d = day(n);
    if (!d.endsWith('-01') && !isOnCalendarGrid(FOUR_WEEKS, d) && !d.endsWith('-07')) return d;
  }
})();
/** The last 7th of a month on or before today: the established plan's off-calendar anchor. */
const OFF_GRID_ANCHOR = (() => {
  for (let n = 0; ; n -= 1) if (day(n).endsWith('-07')) return day(n);
})();

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'M', `own-cal-${uniq()}@example.com`]);
  return insertId;
}
async function product(name: string, frequency: string, amount: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, status, enrollment_status, is_system,
        currency, amount, tax_behavior)
     VALUES (?, ?, 'fee', ?, 'active', 'public', 0, 'EUR', ?, 'inclusive')`, [gymId, name, frequency, amount]);
  return Number(insertId);
}
async function plan(price: number, periodical: Array<{ productId: number }> = []): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', '2')`, [gymId, `OwnCal-${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, ?, '2020-01-01', 'active')`, [gymId, insertId, price]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  for (const p of periodical) {
    await db.query(
      `INSERT INTO membership_plan_periodical (gym_id, membership_plan_id, product_id, quantity) VALUES (?, ?, ?, 1)`,
      [gymId, insertId, p.productId]);
  }
  return Number(insertId);
}

/** An Active version whose `plan` schedule is moved to the 7th: a plan opened before #2125 M5c. */
async function establishedOffGridVersion(owner: number, planId: number, fee: number): Promise<{ setId: number; scheduleId: number }> {
  return db.transaction(async (tx) => {
    const d = await createDraft(tx, { gymId, ownerMemberId: owner, membershipPlanId: planId, startsAt: OFF_GRID_ANCHOR, actor });
    if (d.kind !== 'created') throw new Error(d.kind);
    await snapshotProductSetFromPlan(tx, { gymId, productSetId: d.productSet.id, membershipPlanId: planId, membershipFeePrice: fee, startsAt: OFF_GRID_ANCHOR });
    await addCoverage(tx, { gymId, productSetId: d.productSet.id, memberId: owner, isOwner: true });
    const { rows } = await tx.query<any>(
      `SELECT s.schedule_id FROM product_set_plan_snapshots j JOIN plan_snapshots s ON s.id = j.plan_snapshot_id
        WHERE j.product_set_id = ?`, [d.productSet.id]);
    const scheduleId = Number(rows[0].schedule_id);
    await tx.query('UPDATE product_set_schedules SET anchor_date = ? WHERE id = ?', [OFF_GRID_ANCHOR, scheduleId]);
    const out = await activateWithEvents(tx, { gymId, productSetId: d.productSet.id, today: TODAY });
    if (out.kind !== 'ok') throw new Error(out.kind);
    return { setId: d.productSet.id, scheduleId };
  });
}

async function scheduleOf(table: 'plan_snapshots' | 'plan_periodical_snapshots', id: number) {
  const { rows } = await db.query<any>(
    `SELECT sch.id, sch.schedule_key, DATE_FORMAT(sch.anchor_date, '%Y-%m-%d') AS anchor,
            sch.cadence_interval, sch.cadence_unit
       FROM ${table} t JOIN product_set_schedules sch ON sch.id = t.schedule_id WHERE t.id = ?`, [id]);
  return rows[0];
}

beforeAll(async () => { gymId = await createTestGym('Plan own calendar gym'); });
afterAll(async () => { await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]); await cleanupTestGyms(); await db.end(); });

describe('a Membership Plan added beside an off-calendar plan (#3280)', () => {
  it('bills on the 1st, prorated over its own month, and leaves the established plan where it was', async () => {
    const owner = await member();
    const first = await plan(50);
    const second = await plan(31);
    const established = await establishedOffGridVersion(owner, first, 50);
    const eventsBefore = await db.query<any>(
      `SELECT id, DATE_FORMAT(billing_date, '%Y-%m-%d') AS d, amount FROM billing_events
        WHERE schedule_id = ? ORDER BY id`, [established.scheduleId]);

    const { draftId, snapshotId } = await db.transaction(async (tx) => {
      const out = await ensureRecurringDraft(tx, { gymId, memberId: owner, actor, today: TODAY });
      if (out.kind !== 'ok') throw new Error(out.kind);
      const id = await addPlanSnapshotToVersion(tx, {
        gymId, productSetId: out.productSetId, memberId: owner, membershipPlanId: second,
        membershipFeePrice: 31, startsAt: JOIN_START,
      });
      return { draftId: out.productSetId, snapshotId: id };
    });

    const schedule = await scheduleOf('plan_snapshots', snapshotId);
    expect(schedule.id).not.toBe(established.scheduleId);
    expect(schedule.anchor).toBe(calendarAnchorOnOrBefore(MONTH, JOIN_START));
    expect(schedule.anchor.endsWith('-01')).toBe(true);

    // The engine: a prorated stretch to the next 1st over the real month, then every 1st.
    const planned = await planScheduledEvents(gymId, draftId, JOIN_START, 2);
    const fees = planned.flatMap((e) => e.lines.filter((l) => l.kind === 'membership_fee' && l.regular_price === 31)
      .map((l) => ({ date: e.date, l })));
    const nextFirst = advanceBillingDate(`${JOIN_START.slice(0, 8)}01`, 1, 'month');
    expect(fees[0].date).toBe(JOIN_START);
    expect(fees[0].l.proration).toEqual({
      prorated_days: daysBetween(JOIN_START, nextFirst), period_days: daysInMonthOf(JOIN_START),
    });
    expect(fees[1].date).toBe(nextFirst);
    expect(fees[1].l.actual_charge).toBe(31);
    // The established plan still bills on the 7th.
    const firstFees = planned.flatMap((e) => e.lines.filter((l) => l.kind === 'membership_fee' && l.regular_price === 50)
      .map(() => e.date));
    expect(firstFees.every((d) => d.endsWith('-07'))).toBe(true);

    // Nothing of the established plan moved.
    const { rows: anchor } = await db.query<any>(
      `SELECT DATE_FORMAT(anchor_date, '%Y-%m-%d') AS a FROM product_set_schedules WHERE id = ?`, [established.scheduleId]);
    expect(anchor[0].a).toBe(OFF_GRID_ANCHOR);
    const eventsAfter = await db.query<any>(
      `SELECT id, DATE_FORMAT(billing_date, '%Y-%m-%d') AS d, amount FROM billing_events
        WHERE schedule_id = ? ORDER BY id`, [established.scheduleId]);
    expect(eventsAfter.rows).toEqual(eventsBefore.rows);
  });

  it('a new first plan of a fresh Draft does not adopt the off-calendar plan schedule either', async () => {
    const owner = await member();
    const first = await plan(50);
    const second = await plan(31);
    const established = await establishedOffGridVersion(owner, first, 50);
    const snapshotId = await db.transaction(async (tx) => {
      const d = await createDraft(tx, { gymId, ownerMemberId: owner, membershipPlanId: second, startsAt: JOIN_START, actor });
      if (d.kind !== 'created') throw new Error(d.kind);
      await snapshotProductSetFromPlan(tx, { gymId, productSetId: d.productSet.id, membershipPlanId: second, membershipFeePrice: 31, startsAt: JOIN_START });
      const { rows } = await tx.query<any>(
        'SELECT plan_snapshot_id FROM product_set_plan_snapshots WHERE product_set_id = ?', [d.productSet.id]);
      return Number(rows[0].plan_snapshot_id);
    });
    const schedule = await scheduleOf('plan_snapshots', snapshotId);
    expect(schedule.id).not.toBe(established.scheduleId);
    expect(schedule.anchor.endsWith('-01')).toBe(true);
  });

  it('each included Product follows its own cadence calendar: monthly with its plan, 4-weekly on the 28-day grid', async () => {
    const owner = await member();
    const first = await plan(50);
    const monthly = await product(`Locker-${uniq()}`, 'month', 31);
    const fourWeekly = await product(`Towel-${uniq()}`, 'four_weeks', 28);
    const second = await plan(31, [{ productId: monthly }, { productId: fourWeekly }]);
    const established = await establishedOffGridVersion(owner, first, 50);
    // An off-grid 4-weekly schedule the owner already holds (opened on its own start day).
    const offGridFourWeek = calendarAnchorOnOrBefore(FOUR_WEEKS, TODAY);
    const { insertId: off4w } = await db.query(
      `INSERT INTO product_set_schedules
         (gym_id, opened_by_product_set_id, owner_member_id, schedule_key, anchor_date, cadence_interval, cadence_unit)
       VALUES (?, ?, ?, 's9', DATE_ADD(?, INTERVAL 3 DAY), 4, 'week')`,
      [gymId, established.setId, owner, offGridFourWeek]);

    const { draftId, snapshotId } = await db.transaction(async (tx) => {
      const out = await ensureRecurringDraft(tx, { gymId, memberId: owner, actor, today: TODAY });
      if (out.kind !== 'ok') throw new Error(out.kind);
      const id = await addPlanSnapshotToVersion(tx, {
        gymId, productSetId: out.productSetId, memberId: owner, membershipPlanId: second,
        membershipFeePrice: 31, startsAt: JOIN_START,
      });
      const { allocateItemSchedules } = await import('../api/product-set-configuration');
      await allocateItemSchedules(tx, gymId, out.productSetId);
      return { draftId: out.productSetId, snapshotId: id };
    });

    const planSchedule = await scheduleOf('plan_snapshots', snapshotId);
    const { rows: lines } = await db.query<any>(
      'SELECT id, product_id FROM plan_periodical_snapshots WHERE plan_snapshot_id = ?', [snapshotId]);
    const lineOf = (productId: number) => Number(lines.find((l: any) => Number(l.product_id) === productId).id);
    const monthlySchedule = await scheduleOf('plan_periodical_snapshots', lineOf(monthly));
    const fourWeekSchedule = await scheduleOf('plan_periodical_snapshots', lineOf(fourWeekly));
    expect(monthlySchedule.id).toBe(planSchedule.id);
    expect(fourWeekSchedule.id).not.toBe(Number(off4w));
    expect(isOnCalendarGrid(FOUR_WEEKS, fourWeekSchedule.anchor)).toBe(true);

    const planned = await planScheduledEvents(gymId, draftId, JOIN_START, 2);
    const towel = planned.flatMap((e) => e.lines.filter((l) => l.product_id === fourWeekly).map((l) => ({ date: e.date, l })));
    const nextGrid = (() => {
      const a = calendarAnchorOnOrBefore(FOUR_WEEKS, JOIN_START);
      return advanceBillingDate(a, 4, 'week');
    })();
    expect(towel[0].date).toBe(JOIN_START);
    expect(towel[0].l.proration).toEqual({ prorated_days: daysBetween(JOIN_START, nextGrid), period_days: 28 });
    expect(towel[1].date).toBe(nextGrid);
    const locker = planned.flatMap((e) => e.lines.filter((l) => l.product_id === monthly).map((l) => ({ date: e.date, l })));
    expect(locker[0].l.proration?.period_days).toBe(daysInMonthOf(JOIN_START));
    expect(locker[1].date.endsWith('-01')).toBe(true);
  });
});
