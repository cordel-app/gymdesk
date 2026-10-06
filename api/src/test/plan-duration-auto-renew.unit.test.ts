// #1130 stage 1 — the Billing & Duration stretch is a **cycle**, and
// `auto_renew` is what says whether it starts again.
//
// Before this ticket `classifyPlanDurationPeriod()` ran the timeline once and
// everything after the Bonus Duration was `pay_regular`, for ever;
// `billing_policies.auto_renew` was stored, shown on the Plan card and read by
// nothing. The thread's answers are what these cases assert:
//
//   A (`new-only`)  the flag is the **assignment's own** frozen value, so a
//                   contract that already exists does not start renewing
//                   because the deploy happened. That half is the migration and
//                   the loaders; here it is simply `repeats: false` behaving
//                   exactly as the module did before.
//   B              the Pre-paid lump is owed again at the start of **every**
//                   iteration.
//   C (`regular`)   `auto_renew = false` is today's engine unchanged: one cycle,
//                   then the regular price, and the membership does not expire.
//
// Pure functions, no DB and no HTTP, so these are unit tests (CLAUDE.md).

import { describe, expect, it } from 'vitest';
import {
  MembershipFeeContext,
  resolveMembershipFee,
} from '../domain/billingSimulation';
import { NO_PERSONAL_FEE_BENEFIT } from '../domain/personalFeeBenefit';
import {
  MAX_TIMELINE_PERIODS,
  computePlanExampleTimeline,
} from '../domain/planExampleTimeline';
import {
  PlanDurationCadence,
  classifyPlanDurationPeriod,
  planDurationCycleLength,
  prepaidPeriodsDueOn,
  toPlanDuration,
  toPlanDurationRepeats,
  withDurationCadence,
} from '../domain/planDuration';

const MONTH: PlanDurationCadence = { interval: 1, unit: 'month' };
const FOUR_WEEKS: PlanDurationCadence = { interval: 4, unit: 'week' };
const START = '2026-01-01';

const duration = (
  d: { free?: number; paid?: number; bonus?: number; prepaid?: number; repeats?: boolean },
  cadence: PlanDurationCadence = MONTH,
) => toPlanDuration(
  d.free ?? 0, d.paid ?? 0, d.bonus ?? 0, d.prepaid ?? 0, cadence, d.repeats ?? false,
);

/** The 1st of the month `n` months after January 2026 — one period per month. */
const month = (n: number) => {
  const d = new Date(Date.UTC(2026, 0 + n, 1));
  return d.toISOString().slice(0, 10);
};

describe('toPlanDurationRepeats', () => {
  it('reads mysql2\'s TINYINT(1) and a real boolean alike', () => {
    expect(toPlanDurationRepeats(1)).toBe(true);
    expect(toPlanDurationRepeats(0)).toBe(false);
    expect(toPlanDurationRepeats(true)).toBe(true);
    expect(toPlanDurationRepeats(false)).toBe(false);
    expect(toPlanDurationRepeats('1')).toBe(true);
    expect(toPlanDurationRepeats('0')).toBe(false);
  });

  // The safe direction: `false` is what every assignment written before
  // migration 230 means and what the engine did before this ticket, so an
  // unreadable value costs the renewal rather than inventing one.
  it('answers false for anything it cannot read as a number', () => {
    expect(toPlanDurationRepeats(null)).toBe(false);
    expect(toPlanDurationRepeats(undefined)).toBe(false);
    expect(toPlanDurationRepeats('')).toBe(false);
    expect(toPlanDurationRepeats('yes')).toBe(false);
    expect(toPlanDurationRepeats({})).toBe(false);
  });
});

describe('planDurationCycleLength', () => {
  it('is Free + Paid + Bonus', () => {
    expect(planDurationCycleLength(duration({ free: 3, paid: 12, bonus: 2 }))).toBe(17);
  });

  // The Pre-paid Duration is the first slice *of* the Paid Duration (it is
  // clamped to it), so counting it would make every pre-paid contract's cycle
  // too long and push its second iteration out by that many periods.
  it('does not count the Pre-paid Duration a second time', () => {
    expect(planDurationCycleLength(duration({ free: 3, paid: 12, bonus: 2, prepaid: 12 }))).toBe(17);
  });

  it('is 0 for a Plan with nothing configured — a cycle that cannot repeat', () => {
    expect(planDurationCycleLength(duration({}))).toBe(0);
  });
});

/* ── C: auto_renew = false is the pre-#1130 engine, to the letter ─────────── */

describe('classifyPlanDurationPeriod with auto_renew off', () => {
  const d = duration({ free: 3, paid: 12, bonus: 2 });

  it('runs the cycle once and then charges the regular price for ever', () => {
    expect(classifyPlanDurationPeriod(d, START, month(0))).toBe('free_plan');
    expect(classifyPlanDurationPeriod(d, START, month(2))).toBe('free_plan');
    expect(classifyPlanDurationPeriod(d, START, month(3))).toBe('pay_plan');
    expect(classifyPlanDurationPeriod(d, START, month(14))).toBe('pay_plan');
    expect(classifyPlanDurationPeriod(d, START, month(15))).toBe('bonus_plan');
    expect(classifyPlanDurationPeriod(d, START, month(16))).toBe('bonus_plan');
    // Period 18 onwards — the contract does not expire, it simply bills.
    expect(classifyPlanDurationPeriod(d, START, month(17))).toBe('pay_regular');
    expect(classifyPlanDurationPeriod(d, START, month(40))).toBe('pay_regular');
    expect(classifyPlanDurationPeriod(d, START, month(400))).toBe('pay_regular');
  });
});

/* ── The ticket's own worked example, with auto_renew on ──────────────────── */

describe('classifyPlanDurationPeriod with auto_renew on', () => {
  // The reply's example: 12 pre-paid months then 3 free, repeating. Periods
  // 1–12 Pre-paid, 13–15 Free, then 16–27 Pre-paid and 28–30 Free again.
  const prepaidThenFree = duration({ paid: 12, prepaid: 12, bonus: 3, repeats: true });

  it('restarts the configured cycle instead of falling through to the regular price', () => {
    expect(classifyPlanDurationPeriod(prepaidThenFree, START, month(0))).toBe('prepaid_plan');
    expect(classifyPlanDurationPeriod(prepaidThenFree, START, month(11))).toBe('prepaid_plan');
    expect(classifyPlanDurationPeriod(prepaidThenFree, START, month(12))).toBe('bonus_plan');
    expect(classifyPlanDurationPeriod(prepaidThenFree, START, month(14))).toBe('bonus_plan');
    // Cycle 2 — period 16 in the reply's numbering.
    expect(classifyPlanDurationPeriod(prepaidThenFree, START, month(15))).toBe('prepaid_plan');
    expect(classifyPlanDurationPeriod(prepaidThenFree, START, month(26))).toBe('prepaid_plan');
    expect(classifyPlanDurationPeriod(prepaidThenFree, START, month(27))).toBe('bonus_plan');
    expect(classifyPlanDurationPeriod(prepaidThenFree, START, month(29))).toBe('bonus_plan');
    // Cycle 3, and on indefinitely.
    expect(classifyPlanDurationPeriod(prepaidThenFree, START, month(30))).toBe('prepaid_plan');
  });

  // Q3's other example: Free → Paid → Bonus must restart at Free, never
  // continue into Paid.
  it('restarts at the Free Period rather than continuing into the Paid stretch', () => {
    const d = duration({ free: 3, paid: 12, bonus: 2, repeats: true });
    expect(classifyPlanDurationPeriod(d, START, month(16))).toBe('bonus_plan');
    expect(classifyPlanDurationPeriod(d, START, month(17))).toBe('free_plan');
    expect(classifyPlanDurationPeriod(d, START, month(19))).toBe('free_plan');
    expect(classifyPlanDurationPeriod(d, START, month(20))).toBe('pay_plan');
    // Cycle 3's free periods, 34 months in.
    expect(classifyPlanDurationPeriod(d, START, month(34))).toBe('free_plan');
  });

  it('never answers pay_regular for a cycle of non-zero length', () => {
    const d = duration({ free: 1, paid: 2, bonus: 1, repeats: true });
    for (let n = 0; n < 60; n += 1) {
      expect(classifyPlanDurationPeriod(d, START, month(n))).not.toBe('pay_regular');
    }
  });

  // A zero-length cycle has nothing to repeat: `repeats` must be inert rather
  // than a reason to walk iteration boundaries that never advance.
  it('is inert for a Plan with no Billing & Duration at all', () => {
    const d = duration({ repeats: true });
    expect(classifyPlanDurationPeriod(d, START, month(0))).toBe('pay_regular');
    expect(classifyPlanDurationPeriod(d, START, month(99))).toBe('pay_regular');
  });

  it('still says nothing is waived before the contract starts', () => {
    const d = duration({ free: 3, paid: 12, bonus: 2, repeats: true });
    expect(classifyPlanDurationPeriod(d, START, '2025-12-31')).toBe('pay_regular');
  });

  // #892 — an iteration is a count of the assignment's own Billing Frequency
  // periods, so a 4-weekly cycle restarts after 4 x 28 days, not 4 months.
  it('counts an iteration in the cadence the durations are counted in', () => {
    const d = duration({ free: 2, paid: 2, bonus: 0, repeats: true }, FOUR_WEEKS);
    expect(classifyPlanDurationPeriod(d, START, '2026-01-01')).toBe('free_plan');   // period 1
    expect(classifyPlanDurationPeriod(d, START, '2026-01-29')).toBe('free_plan');   // period 2
    expect(classifyPlanDurationPeriod(d, START, '2026-02-26')).toBe('pay_plan');    // period 3
    expect(classifyPlanDurationPeriod(d, START, '2026-03-26')).toBe('pay_plan');    // period 4
    expect(classifyPlanDurationPeriod(d, START, '2026-04-23')).toBe('free_plan');   // cycle 2
  });

  // The boundaries are each a single step from the anchor, so end-of-month
  // clamping cannot accumulate across iterations and reorder them.
  it('does not drift when the start date has no counterpart in every month', () => {
    const d = duration({ free: 1, paid: 1, bonus: 0, repeats: true });
    const jan31 = '2026-01-31';
    expect(classifyPlanDurationPeriod(d, jan31, '2026-01-31')).toBe('free_plan');
    expect(classifyPlanDurationPeriod(d, jan31, '2026-03-31')).toBe('free_plan');
    expect(classifyPlanDurationPeriod(d, jan31, '2026-05-31')).toBe('free_plan');
    expect(classifyPlanDurationPeriod(d, jan31, '2026-07-31')).toBe('free_plan');
  });

  it('survives rebinding to another cadence with the flag intact', () => {
    const d = duration({ free: 1, paid: 1, repeats: true });
    expect(withDurationCadence(d, FOUR_WEEKS).repeats).toBe(true);
  });
});

/* ── B: the Pre-paid lump recurs once per iteration ───────────────────────── */

describe('prepaidPeriodsDueOn across iterations', () => {
  it('owes the whole Pre-paid Duration again at the start of each cycle', () => {
    // €70/month, 12 pre-paid + 3 bonus, renewing: €840 on period 1 and again
    // on period 16, and nothing in between.
    const d = duration({ paid: 12, prepaid: 12, bonus: 3, repeats: true });
    expect(prepaidPeriodsDueOn(d, START, month(0))).toBe(12);
    expect(prepaidPeriodsDueOn(d, START, month(1))).toBe(0);
    expect(prepaidPeriodsDueOn(d, START, month(11))).toBe(0);
    expect(prepaidPeriodsDueOn(d, START, month(12))).toBe(0);   // bonus
    expect(prepaidPeriodsDueOn(d, START, month(15))).toBe(12);  // cycle 2's lump
    expect(prepaidPeriodsDueOn(d, START, month(16))).toBe(0);
    expect(prepaidPeriodsDueOn(d, START, month(30))).toBe(12);  // cycle 3's lump
  });

  it('is owed anywhere inside that period, not only on its exact billing date', () => {
    const d = duration({ paid: 3, prepaid: 3, repeats: true });
    expect(prepaidPeriodsDueOn(d, START, '2026-04-17')).toBe(3);
  });

  it('is unchanged for a contract that does not renew (#946)', () => {
    const d = duration({ paid: 12, prepaid: 12, bonus: 3 });
    expect(prepaidPeriodsDueOn(d, START, month(0))).toBe(12);
    expect(prepaidPeriodsDueOn(d, START, month(15))).toBe(0);
    expect(prepaidPeriodsDueOn(d, START, month(30))).toBe(0);
  });

  it('starts counting after the Free Period in every iteration', () => {
    const d = duration({ free: 1, paid: 3, prepaid: 2, repeats: true });
    expect(prepaidPeriodsDueOn(d, START, month(0))).toBe(0);  // free
    expect(prepaidPeriodsDueOn(d, START, month(1))).toBe(2);  // cycle 1's lump
    expect(prepaidPeriodsDueOn(d, START, month(2))).toBe(0);
    expect(prepaidPeriodsDueOn(d, START, month(4))).toBe(0);  // cycle 2's free period
    expect(prepaidPeriodsDueOn(d, START, month(5))).toBe(2);  // cycle 2's lump
  });
});

/* ── What the run actually charges ────────────────────────────────────────── */

// The classifier is only half the answer: `resolveMembershipFee()` is the one
// implementation every surface prices a cycle through (the nightly run, both
// simulations, `GET /me/membership`, `POST /payment-requests`), so these are
// the cases that say the *money* follows the cycle rather than only the label.

const context = (over: Partial<MembershipFeeContext> = {}): MembershipFeeContext => ({
  startsAt: START,
  planDuration: duration({ free: 3, paid: 12, bonus: 2, repeats: true }),
  promotions: [],
  personalFeeBenefit: NO_PERSONAL_FEE_BENEFIT,
  ...over,
});

describe('resolveMembershipFee over a renewing cycle', () => {
  it('waives the second iteration\'s Free Period instead of charging the regular fee', () => {
    // Period 18 is the first of cycle 2. Before #1130 this charged €70.
    const resolved = resolveMembershipFee(70, month(17), context());
    expect(resolved.amount).toBe(0);
    expect(resolved.benefits).toEqual([{
      source: 'membership_plan', name: null, action: 'waive', value: null, period_status: 'free_plan',
    }]);
  });

  it('charges the regular fee in the second iteration\'s Paid stretch', () => {
    expect(resolveMembershipFee(70, month(20), context()).amount).toBe(70);
  });

  it('charges the regular fee from the second period on when the cycle does not renew', () => {
    const once = context({ planDuration: duration({ free: 3, paid: 12, bonus: 2 }) });
    expect(resolveMembershipFee(70, month(17), once).amount).toBe(70);
    expect(resolveMembershipFee(70, month(40), once).amount).toBe(70);
  });

  it('collects the Pre-paid lump again at the start of the second iteration', () => {
    const prepaid = context({
      planDuration: duration({ paid: 12, prepaid: 12, bonus: 3, repeats: true }),
    });
    const first = resolveMembershipFee(70, month(0), prepaid);
    expect(first.amount).toBe(840);
    expect(first.prepaidPeriods).toBe(12);
    const second = resolveMembershipFee(70, month(15), prepaid);
    expect(second.amount).toBe(840);
    expect(second.prepaidPeriods).toBe(12);
    // And the periods each lump paid for still generate no billing event.
    expect(resolveMembershipFee(70, month(16), prepaid).quantity).toBe(0);
  });
});

/* ── How far the Membership Fee Simulation runs ───────────────────────────── */

// Both projections stopped by *reaching the regular price*: the walk ran until
// `TRAILING_REGULAR_PERIODS` regular periods had been shown. A repeating cycle
// never reaches one, so without a second rule every renewing Plan's table would
// run to `MAX_TIMELINE_PERIODS`. The stopping rule for such a contract is
// therefore two complete iterations — the number the ticket asks the table to
// show before `↻ Repeats indefinitely` (whose rendering is stage 2's).

describe('computePlanExampleTimeline over a renewing cycle', () => {
  const timeline = (repeats: boolean) => computePlanExampleTimeline({
    duration: duration({ free: 1, paid: 2, bonus: 1, repeats }),
    cadence: MONTH,
    priceInclTax: 60,
    anchorDate: START,
  });

  it('shows two complete iterations and nothing more', () => {
    const { periods } = timeline(true);
    expect(periods).toHaveLength(8);
    expect(periods.map((p) => p.status)).toEqual([
      'free_plan', 'pay_plan', 'pay_plan', 'bonus_plan',
      'free_plan', 'pay_plan', 'pay_plan', 'bonus_plan',
    ]);
  });

  // The open-ended final row says "and it carries on at this price". A
  // repeating cycle's last row is a Bonus period, and "Bonus, from X onwards"
  // is exactly the lie the walk already refuses to tell when the row budget
  // cuts a duration short.
  it('leaves the last row closed rather than claiming it runs on', () => {
    const { periods } = timeline(true);
    expect(periods[periods.length - 1].endsOn).not.toBeNull();
    expect(periods.filter((p) => p.endsOn === null)).toHaveLength(0);
  });

  it('keeps the trailing-regular rule for a cycle that does not repeat', () => {
    const { periods } = timeline(false);
    expect(periods.map((p) => p.status)).toEqual([
      'free_plan', 'pay_plan', 'pay_plan', 'bonus_plan', 'pay_regular', 'pay_regular',
    ]);
    expect(periods[periods.length - 1].endsOn).toBeNull();
  });

  // A Plan with nothing configured has a zero-length cycle, so `repeats` cannot
  // change what it shows: two regular periods, the second open-ended.
  it('is unaffected for a Plan with no Billing & Duration', () => {
    const { periods } = computePlanExampleTimeline({
      duration: duration({ repeats: true }),
      cadence: MONTH,
      priceInclTax: 60,
      anchorDate: START,
    });
    expect(periods.map((p) => p.status)).toEqual(['pay_regular', 'pay_regular']);
    expect(periods[1].endsOn).toBeNull();
  });

  it('never exceeds the row budget, however long the cycle', () => {
    const { periods } = computePlanExampleTimeline({
      duration: duration({ free: 40, paid: 40, bonus: 40, repeats: true }),
      cadence: MONTH,
      priceInclTax: 60,
      anchorDate: START,
    });
    expect(periods).toHaveLength(MAX_TIMELINE_PERIODS);
  });
});
