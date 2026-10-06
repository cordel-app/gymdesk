// Unit tests for domain/planDuration.ts (#635 stage 8, #892) — the Membership
// Plan's own Free → Pre-paid → Paid → Bonus → Regular classification is a pure
// function with no DB or HTTP dependency, so per CLAUDE.md these are unit
// tests: no createTestGym, no cleanupTestGyms, no db.end().
//
// #892 makes the durations counts of the Plan's **Billing Frequency periods**,
// so every case below is anchored on a cadence, and the regression block at the
// bottom asserts the same numbers produce different *dates* under Month and
// 4 Weeks — which is the whole ticket.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PLAN_DURATION_CADENCE,
  NO_PLAN_DURATION,
  PlanDurationCadence,
  classifyPlanDurationPeriod,
  planDurationWaivesFee,
  toPlanDuration,
  toPlanDurationCadence,
  withDurationCadence,
} from '../domain/planDuration';

const START = '2026-03-15';
const MONTH: PlanDurationCadence = { interval: 1, unit: 'month' };
const FOUR_WEEKS: PlanDurationCadence = { interval: 4, unit: 'week' };
/** A pre-#820 pair: still stored, still billed, still stepped as stored. */
const TWO_MONTHS: PlanDurationCadence = { interval: 2, unit: 'month' };

describe('toPlanDuration', () => {
  it('normalizes NULL columns to zero — "never configured" bills like "no such period"', () => {
    expect(toPlanDuration(null, null, null, null, MONTH, false)).toEqual(NO_PLAN_DURATION);
  });

  it('accepts the strings mysql2 can hand back for an INT column', () => {
    expect(toPlanDuration('1', '12', '2', '3', FOUR_WEEKS, false))
      .toEqual({
        freePeriods: 1, paidPeriods: 12, bonusPeriods: 2, prepaidPeriods: 3, cadence: FOUR_WEEKS,
        repeats: false,
      });
  });

  // #635 stage 13: the Pre-paid Duration is a slice of the Paid Duration, so a
  // row carrying more prepaid periods than paid ones (written before the API
  // validated the bound, or edited straight in the DB) is clamped rather than
  // allowed to prepay periods the contract never had.
  it('clamps the prepaid periods to the paid ones', () => {
    expect(toPlanDuration(0, 3, 0, 5, MONTH, false).prepaidPeriods).toBe(3);
    expect(toPlanDuration(0, 0, 0, 2, MONTH, false).prepaidPeriods).toBe(0);
    expect(toPlanDuration(1, 12, 2, null, MONTH, false).prepaidPeriods).toBe(0);
  });

  it('clamps a negative or non-numeric value to zero rather than inverting a boundary', () => {
    expect(toPlanDuration(-3, 'nonsense', undefined, undefined, MONTH, false)).toEqual(NO_PLAN_DURATION);
  });

  // #892 — a count with no cadence is meaningless, so an unusable pair falls
  // back to the one every duration meant before the ticket rather than being
  // stepped by a zero-length period.
  it('falls back to one month for a missing or unusable cadence', () => {
    expect(toPlanDurationCadence(null, null)).toEqual(DEFAULT_PLAN_DURATION_CADENCE);
    expect(toPlanDurationCadence(0, 'month')).toEqual(DEFAULT_PLAN_DURATION_CADENCE);
    expect(toPlanDurationCadence(-2, 'week')).toEqual(DEFAULT_PLAN_DURATION_CADENCE);
    expect(toPlanDurationCadence(1, 'fortnight')).toEqual(DEFAULT_PLAN_DURATION_CADENCE);
    expect(toPlanDuration(1, 1, 1, 0, undefined as any, false).cadence).toEqual(DEFAULT_PLAN_DURATION_CADENCE);
  });

  it('keeps a cadence outside #820\'s two choices exactly as stored', () => {
    expect(toPlanDurationCadence('2', 'month')).toEqual(TWO_MONTHS);
  });

  // §6 — changing the Billing Frequency changes the unit, never the numbers.
  it('re-binds a duration to another cadence without touching its counts', () => {
    const monthly = toPlanDuration(1, 2, 3, 1, MONTH, false);
    expect(withDurationCadence(monthly, FOUR_WEEKS)).toEqual({ ...monthly, cadence: FOUR_WEEKS });
  });
});

describe('classifyPlanDurationPeriod', () => {
  const duration = toPlanDuration(1, 2, 2, 0, MONTH, false); // free 1 · paid 2 · bonus 2

  it('is the free period from the start date up to (not including) the next month', () => {
    expect(classifyPlanDurationPeriod(duration, START, START)).toBe('free_plan');
    expect(classifyPlanDurationPeriod(duration, START, '2026-04-14')).toBe('free_plan');
  });

  it('moves to the paid duration exactly one month in', () => {
    expect(classifyPlanDurationPeriod(duration, START, '2026-04-15')).toBe('pay_plan');
    expect(classifyPlanDurationPeriod(duration, START, '2026-06-14')).toBe('pay_plan');
  });

  it('then to the bonus duration, then to the regular period, open-ended', () => {
    expect(classifyPlanDurationPeriod(duration, START, '2026-06-15')).toBe('bonus_plan');
    expect(classifyPlanDurationPeriod(duration, START, '2026-08-14')).toBe('bonus_plan');
    expect(classifyPlanDurationPeriod(duration, START, '2026-08-15')).toBe('pay_regular');
    expect(classifyPlanDurationPeriod(duration, START, '2031-01-01')).toBe('pay_regular');
  });

  it('is the regular period everywhere when nothing is configured', () => {
    expect(classifyPlanDurationPeriod(NO_PLAN_DURATION, START, START)).toBe('pay_regular');
  });

  it('skips a period configured as zero', () => {
    const noFree = toPlanDuration(0, 1, 1, 0, MONTH, false);
    expect(classifyPlanDurationPeriod(noFree, START, START)).toBe('pay_plan');
    expect(classifyPlanDurationPeriod(noFree, START, '2026-04-15')).toBe('bonus_plan');
  });

  it('waives nothing before the assignment it belongs to starts', () => {
    expect(classifyPlanDurationPeriod(duration, START, '2026-03-14')).toBe('pay_regular');
  });

  // Every boundary is measured from the start date in one step, so the
  // end-of-month clamping `advanceBillingDate` inherits from Date.setUTCMonth
  // (31 Jan + 1 month = 3 Mar) cannot accumulate and put a later boundary
  // before an earlier one.
  it('keeps its boundaries in order for a start date at the end of a month', () => {
    const endOfMonth = '2026-01-31';
    const long = toPlanDuration(1, 1, 1, 0, MONTH, false);
    expect(classifyPlanDurationPeriod(long, endOfMonth, '2026-02-28')).toBe('free_plan');
    expect(classifyPlanDurationPeriod(long, endOfMonth, '2026-03-03')).toBe('pay_plan');
    expect(classifyPlanDurationPeriod(long, endOfMonth, '2026-03-31')).toBe('bonus_plan');
    expect(classifyPlanDurationPeriod(long, endOfMonth, '2026-05-01')).toBe('pay_regular');
  });
});

// ─── #892: the durations are counts of Billing Frequency periods ─────────────
describe('classifyPlanDurationPeriod across billing frequencies', () => {
  const anchor = '2026-01-01';
  // The same four numbers, read under three different cadences.
  const counts = [1, 2, 2, 0] as const;

  it('Month — one period is one calendar month (unchanged behaviour)', () => {
    const d = toPlanDuration(...counts, MONTH);
    expect(classifyPlanDurationPeriod(d, anchor, '2026-01-31')).toBe('free_plan');
    expect(classifyPlanDurationPeriod(d, anchor, '2026-02-01')).toBe('pay_plan');
    expect(classifyPlanDurationPeriod(d, anchor, '2026-03-31')).toBe('pay_plan');
    expect(classifyPlanDurationPeriod(d, anchor, '2026-04-01')).toBe('bonus_plan');
    expect(classifyPlanDurationPeriod(d, anchor, '2026-06-01')).toBe('pay_regular');
  });

  it('4 Weeks — one period is 28 days, so the same numbers end sooner', () => {
    const d = toPlanDuration(...counts, FOUR_WEEKS);
    // Free: 1 × 28 days → 1 Jan .. 28 Jan.
    expect(classifyPlanDurationPeriod(d, anchor, '2026-01-28')).toBe('free_plan');
    expect(classifyPlanDurationPeriod(d, anchor, '2026-01-29')).toBe('pay_plan');
    // Paid: 2 × 28 days → up to 25 Mar; Bonus: 2 × 28 days → up to 20 May.
    expect(classifyPlanDurationPeriod(d, anchor, '2026-03-25')).toBe('pay_plan');
    expect(classifyPlanDurationPeriod(d, anchor, '2026-03-26')).toBe('bonus_plan');
    expect(classifyPlanDurationPeriod(d, anchor, '2026-05-20')).toBe('bonus_plan');
    expect(classifyPlanDurationPeriod(d, anchor, '2026-05-21')).toBe('pay_regular');
    // The date a monthly reading would still have called free is already paid.
    expect(classifyPlanDurationPeriod(d, anchor, '2026-01-31')).not.toBe('free_plan');
  });

  it('a legacy cadence is stepped exactly as stored — "2" means two of those', () => {
    const d = toPlanDuration(...counts, TWO_MONTHS);
    expect(classifyPlanDurationPeriod(d, anchor, '2026-02-28')).toBe('free_plan');
    expect(classifyPlanDurationPeriod(d, anchor, '2026-03-01')).toBe('pay_plan');
    // Paid: 2 × 2 months → up to 30 Jun; Bonus: 2 × 2 months → up to 31 Oct.
    expect(classifyPlanDurationPeriod(d, anchor, '2026-06-30')).toBe('pay_plan');
    expect(classifyPlanDurationPeriod(d, anchor, '2026-07-01')).toBe('bonus_plan');
    expect(classifyPlanDurationPeriod(d, anchor, '2026-11-01')).toBe('pay_regular');
  });

  it('the Pre-paid Duration is the first of the paid periods, in the same unit', () => {
    const d = toPlanDuration(0, 3, 0, 2, FOUR_WEEKS, false);
    expect(classifyPlanDurationPeriod(d, anchor, anchor)).toBe('prepaid_plan');
    expect(classifyPlanDurationPeriod(d, anchor, '2026-02-25')).toBe('prepaid_plan'); // < 1 Jan + 56d
    expect(classifyPlanDurationPeriod(d, anchor, '2026-02-26')).toBe('pay_plan');
    expect(classifyPlanDurationPeriod(d, anchor, '2026-03-26')).toBe('pay_regular');
  });
});

describe('planDurationWaivesFee', () => {
  it('waives the fee in the free, pre-paid and bonus periods only', () => {
    expect(planDurationWaivesFee('free_plan')).toBe(true);
    expect(planDurationWaivesFee('prepaid_plan')).toBe(true);
    expect(planDurationWaivesFee('bonus_plan')).toBe(true);
    expect(planDurationWaivesFee('pay_plan')).toBe(false);
    expect(planDurationWaivesFee('pay_regular')).toBe(false);
  });
});
