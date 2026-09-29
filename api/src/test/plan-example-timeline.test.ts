// Unit tests for `computePlanExampleTimeline` (#818) — a pure projection, so no
// DB, no HTTP and no test gym (CLAUDE.md: unit tests vs integration tests).
//
// Two properties carry the ticket and both are asserted here: a row is one
// billing period of the *Plan's* cadence, and a row's Status is whatever
// `classifyPlanDurationPeriod()` says is actually billed on its start date.
import { describe, expect, it } from 'vitest';
import {
  MAX_TIMELINE_PERIODS,
  TRAILING_REGULAR_PERIODS,
  computePlanExampleTimeline,
} from '../domain/planExampleTimeline';
import { toPlanDuration } from '../domain/planDuration';

const MONTHLY = { interval: 1, unit: 'month' as const };
const FOUR_WEEKLY = { interval: 4, unit: 'week' as const };

function timeline(
  duration: { free?: number; paid?: number; prepaid?: number; bonus?: number },
  cadence: { interval: number; unit: 'day' | 'week' | 'month' | 'year' } | null = MONTHLY,
  priceInclTax: number | null = 60,
  anchorDate = '2026-09-01',
) {
  return computePlanExampleTimeline({
    // The cadence is passed once here too: `computePlanExampleTimeline` re-binds
    // the duration to the `cadence` it is given (#892), so this argument only
    // proves the two cannot disagree.
    duration: toPlanDuration(
      duration.free ?? 0, duration.paid ?? 0, duration.bonus ?? 0, duration.prepaid ?? 0,
      cadence ?? MONTHLY,
    ),
    cadence,
    priceInclTax,
    anchorDate,
  });
}

const statuses = (result: ReturnType<typeof timeline>) => result.periods.map((p) => p.status);

describe('computePlanExampleTimeline', () => {
  it('needs a billing frequency — a Plan with no billing policy has no timeline', () => {
    const result = timeline({ free: 1 }, null);
    expect(result.available).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(result.periods).toEqual([]);
    expect(result.anchorDate).toBeNull();
  });

  it('refuses a non-positive interval rather than looping on it', () => {
    expect(timeline({ free: 1 }, { interval: 0, unit: 'month' }).available).toBe(false);
  });

  it('projects Free → Prepaid → Pay → Bonus → regular, one row per month', () => {
    const result = timeline({ free: 1, paid: 2, prepaid: 1, bonus: 1 });
    expect(statuses(result)).toEqual([
      'free_plan', 'prepaid_plan', 'pay_plan', 'bonus_plan', 'pay_regular', 'pay_regular',
    ]);
    expect(result.periods.map((p) => p.startsOn)).toEqual([
      '2026-09-01', '2026-10-01', '2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01',
    ]);
    expect(result.periods[0].endsOn).toBe('2026-09-30');
    expect(result.periods[1].endsOn).toBe('2026-10-31');
  });

  it('trails the configured periods with exactly two regular ones', () => {
    const result = timeline({ free: 1, paid: 2, bonus: 1 });
    expect(result.periods).toHaveLength(1 + 2 + 1 + TRAILING_REGULAR_PERIODS);
    expect(statuses(result).filter((s) => s === 'pay_regular')).toHaveLength(TRAILING_REGULAR_PERIODS);
  });

  it('is two regular periods for a Plan with no durations configured', () => {
    const result = timeline({});
    expect(statuses(result)).toEqual(['pay_regular', 'pay_regular']);
  });

  it('charges only the periods the durations do not waive, at the price given', () => {
    const result = timeline({ free: 1, paid: 2, prepaid: 1, bonus: 1 });
    expect(result.periods.map((p) => p.amount)).toEqual([null, null, 60, null, 60, 60]);
    expect(result.periods.map((p) => p.waived)).toEqual([true, true, false, true, false, false]);
  });

  it('quotes nothing for a Plan with no price, and says that is not a waiver', () => {
    const result = timeline({ paid: 1 }, MONTHLY, null);
    expect(result.periods.map((p) => p.amount)).toEqual([null, null, null]);
    expect(result.periods.map((p) => p.waived)).toEqual([false, false, false]);
  });

  it('opens the last row only when it is a regular period', () => {
    const open = timeline({ free: 1 });
    expect(open.periods[open.periods.length - 1].endsOn).toBeNull();
    expect(open.periods.filter((p) => p.endsOn === null)).toHaveLength(1);

    // The row budget (`MAX_TIMELINE_PERIODS`) can end mid-duration — "Bonus,
    // from … onwards" would be a lie, and that row keeps its real end date.
    const stillInDuration = timeline({ free: 80 }, FOUR_WEEKLY);
    const last = stillInDuration.periods[stillInDuration.periods.length - 1];
    expect(last.status).toBe('free_plan');
    expect(last.endsOn).not.toBeNull();
  });

  // #892 reverses #818's Q1 answer, in the run as well as in the preview: a
  // duration is a count of *this Plan's* billing periods, so "Free Period = 2"
  // on a 4-weekly Plan is exactly two 4-week rows. Before #892 the third row
  // was free too (it still started inside two calendar months), which is the
  // inconsistency the ticket is about.
  it('steps 4-weekly rows by 28 days and gives Free Period = 2 exactly two free rows', () => {
    const result = timeline({ free: 2, paid: 1 }, FOUR_WEEKLY);
    expect(result.periods.slice(0, 4).map((p) => p.startsOn)).toEqual([
      '2026-09-01', '2026-09-29', '2026-10-27', '2026-11-24',
    ]);
    expect(statuses(result).slice(0, 4)).toEqual(['free_plan', 'free_plan', 'pay_plan', 'pay_regular']);
    expect(result.periods.map((p) => p.amount)).toEqual([null, null, 60, 60, 60]);
  });

  // The same configuration under the two configurable cadences: the statuses
  // are identical row by row and only the dates differ, which is what "the
  // number is a count of periods" means.
  it('gives the same statuses under Month and 4 Weeks, on different dates', () => {
    const monthly = timeline({ free: 1, paid: 2, bonus: 1 }, MONTHLY);
    const fourWeekly = timeline({ free: 1, paid: 2, bonus: 1 }, FOUR_WEEKLY);
    expect(statuses(fourWeekly)).toEqual(statuses(monthly));
    expect(monthly.periods.map((p) => p.startsOn)).toEqual([
      '2026-09-01', '2026-10-01', '2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01',
    ]);
    expect(fourWeekly.periods.map((p) => p.startsOn)).toEqual([
      '2026-09-01', '2026-09-29', '2026-10-27', '2026-11-24', '2026-12-22', '2027-01-19',
    ]);
  });

  it('anchors on the day it is given — never snapped to the first of the month', () => {
    const result = timeline({ free: 1 }, MONTHLY, 60, '2026-09-17');
    expect(result.anchorDate).toBe('2026-09-17');
    expect(result.periods[0].startsOn).toBe('2026-09-17');
    expect(result.periods[0].endsOn).toBe('2026-10-16');
    expect(result.periods[1].status).toBe('pay_regular');
  });

  it('caps the table rather than rendering a Plan configured with hundreds of periods', () => {
    const result = timeline({ free: 500 });
    expect(result.periods).toHaveLength(MAX_TIMELINE_PERIODS);
    expect(statuses(result).every((s) => s === 'free_plan')).toBe(true);
  });

  it('clamps a Pre-paid Duration longer than the Paid one, as the classifier does', () => {
    const result = timeline({ free: 0, paid: 1, prepaid: 5 });
    expect(statuses(result)).toEqual(['prepaid_plan', 'pay_regular', 'pay_regular']);
  });

  it('steps a legacy cadence exactly as stored', () => {
    const result = timeline({ paid: 1 }, { interval: 2, unit: 'month' });
    expect(result.periods.map((p) => p.startsOn)).toEqual(['2026-09-01', '2026-11-01', '2027-01-01']);
  });
});
