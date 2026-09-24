// Unit tests for domain/planDuration.ts (#635 stage 8) — the Membership Plan's
// own Free → Paid → Bonus → Regular classification is a pure function with no
// DB or HTTP dependency, so per CLAUDE.md these are unit tests: no
// createTestGym, no cleanupTestGyms, no db.end().

import { describe, expect, it } from 'vitest';
import {
  NO_PLAN_DURATION,
  classifyPlanDurationPeriod,
  planDurationWaivesFee,
  toPlanDuration,
} from '../domain/planDuration';

const START = '2026-03-15';

describe('toPlanDuration', () => {
  it('normalizes NULL columns to zero — "never configured" bills like "no such period"', () => {
    expect(toPlanDuration(null, null, null)).toEqual(NO_PLAN_DURATION);
  });

  it('accepts the strings mysql2 can hand back for an INT column', () => {
    expect(toPlanDuration('1', '12', '2')).toEqual({ freeMonths: 1, paidMonths: 12, bonusMonths: 2 });
  });

  it('clamps a negative or non-numeric value to zero rather than inverting a boundary', () => {
    expect(toPlanDuration(-3, 'nonsense', undefined)).toEqual(NO_PLAN_DURATION);
  });
});

describe('classifyPlanDurationPeriod', () => {
  const duration = toPlanDuration(1, 2, 2); // free 1 · paid 2 · bonus 2

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
    const noFree = toPlanDuration(0, 1, 1);
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
    const long = toPlanDuration(1, 1, 1);
    expect(classifyPlanDurationPeriod(long, endOfMonth, '2026-02-28')).toBe('free_plan');
    expect(classifyPlanDurationPeriod(long, endOfMonth, '2026-03-03')).toBe('pay_plan');
    expect(classifyPlanDurationPeriod(long, endOfMonth, '2026-03-31')).toBe('bonus_plan');
    expect(classifyPlanDurationPeriod(long, endOfMonth, '2026-05-01')).toBe('pay_regular');
  });
});

describe('planDurationWaivesFee', () => {
  it('waives the fee in the free and bonus periods only', () => {
    expect(planDurationWaivesFee('free_plan')).toBe(true);
    expect(planDurationWaivesFee('bonus_plan')).toBe(true);
    expect(planDurationWaivesFee('pay_plan')).toBe(false);
    expect(planDurationWaivesFee('pay_regular')).toBe(false);
  });
});
