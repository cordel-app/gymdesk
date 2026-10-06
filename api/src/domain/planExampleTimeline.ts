// #818: a Membership Plan's **Example timeline** — the Promotion's own
// simulation (`promotionTimeline.ts`, rendered by the Promotions card as
// "Example Timeline"), for a Plan.
//
// It replaces the #485 Billing Events Forecast, which listed the next ten
// charges from price × cadence and never consulted the Plan's Billing &
// Duration at all: a Plan with a two-month Free Period forecast a charge for
// every one of those months. The ticket asks for the Promotion's shape instead
// — one row per billing period, with Period / Dates / Status / Billing — so an
// admin can see what the Plan will do to a member before it is assigned to one.
//
// Two rules decide what this module is, and both come from the ticket thread:
//
//  1. **Rows step by the Plan's Billing frequency** (§"Billing Frequency is the
//     source of truth for period length"). A Promotion has no cadence of its
//     own, which is why its timeline steps by one month and says so in a
//     disclaimer; a Plan has one (`billing_policies`, #820's Month | 4 Weeks),
//     so each row is one real billing period and the dates are the dates the
//     member would actually be charged on.
//
//  2. **The status of a row is the status that is actually billed.** It is
//     `classifyPlanDurationPeriod()` (`domain/planDuration.ts`) — the one
//     implementation `resolveMembershipFee()`, the nightly run and
//     `GET /me/membership` price a cycle with — evaluated at the row's own start
//     date. Since #892 that classifier counts the Plan's durations in periods of
//     the very cadence these rows step by, so the two halves of a row can no
//     longer disagree: a 4-weekly Plan with Free Period = 2 shows exactly *two*
//     free rows, and each row's status is the whole row's status. (Until #892 it
//     showed three — the third 4-week period still started inside the two free
//     calendar months — which is the inconsistency #892 removes, in the run as
//     well as in the preview.)
//
// Since #924 stage 3 the walk itself — the period stepping, the horizon and
// the open-ended final row — is the shared `exampleTimeline.ts`, because the
// Assigned Plan card renders the same table for a real assignment (§7). What
// stays here is the Plan's own half: a Plan's price is one number for every
// period, and which period is Free / Pre-paid / Pay / Bonus is
// `classifyPlanDurationPeriod()` alone, since a Membership Plan carries no
// Promotions and no Personal Membership Fee Benefit to outrank it.
//
// Nothing here is persisted and nothing here charges: a Membership Plan is not
// assigned to anybody, so the timeline is an illustration anchored on a
// hypothetical enrollment date (today, UTC, unless the caller names one). It is
// deliberately *not* anchored on the first of the month the way a Promotion's
// preview is — `planDuration.ts` already refuses that snap, because a Plan's
// durations are counted from a real assignment's `starts_at`.

import {
  ExampleTimelineResult,
  MAX_TIMELINE_PERIODS,
  REPEATED_CYCLE_ITERATIONS,
  TRAILING_REGULAR_PERIODS,
  timelineCycleFor,
  walkExampleTimeline,
} from './exampleTimeline';
import {
  PlanDuration,
  PlanDurationCadence,
  PlanDurationStatus,
  classifyPlanDurationPeriod,
  planDurationWaivesFee,
  prepaidPeriodsDueOn,
  withDurationCadence,
} from './planDuration';

/**
 * The cadence one row spans — the Plan's stored `billing_policies` pair, which
 * since #892 is also the unit its durations are counted in
 * (`PlanDurationCadence`).
 */
export type PlanTimelineCadence = PlanDurationCadence;

export interface PlanExampleTimelineInput {
  /**
   * The Plan's Billing & Duration, already normalized by `toPlanDuration()`.
   * Its counts are what matter here — the cadence it carries is re-bound to
   * `cadence` below, so the rows and the statuses cannot be stepped by
   * different period lengths.
   */
  duration: PlanDuration;
  /**
   * The Plan's `(recurring_billing_interval, recurring_billing_unit)`, or
   * `null` when it has no `billing_policies` row. A cadence outside #820's two
   * choices is stepped exactly as stored — it is still what the Plan bills on.
   */
  cadence: PlanTimelineCadence | null;
  /**
   * What a charged period costs: the Plan's current price **including VAT**
   * (the number the Pricing section shows), or `null` when the Plan has no
   * price configured yet. Computed server-side — the timeline never does tax
   * arithmetic of its own (#817).
   */
  priceInclTax: number | null;
  /** Hypothetical enrollment date, `YYYY-MM-DD`. Defaults to today (UTC). */
  anchorDate?: string;
}

/**
 * One row. The shared shape, narrowed to the statuses a *Plan* can produce:
 * no Promotion is involved in a catalogue preview, so a `*_promotion` status
 * can never appear here.
 */
export interface PlanExampleTimelinePeriod {
  period: number;
  status: PlanDurationStatus;
  startsOn: string; // YYYY-MM-DD
  /** `null` on the final row when it is open-ended — billing continues. */
  endsOn: string | null;
  /**
   * What this period charges: the price for a charged period, `null` for one
   * the Plan's own durations waive (Free / Bonus) or have already collected
   * (a Pre-paid period after the first), and `null` too when the Plan has no
   * price configured.
   *
   * #946 — the **first** Pre-paid period is not one of those: it is where the
   * whole Pre-paid Duration is collected, so it carries the fee times the
   * periods it pays for (`prepaidPeriods` below) and is not waived. Otherwise
   * this table would read `No charge` for the very date the Billing Event
   * Simulation beside it bills.
   */
  amount: number | null;
  /** Whether `amount: null` means "no charge" rather than "no price yet". */
  waived: boolean;
  /**
   * #946 — how many Pre-paid periods `amount` covers, on the one row that
   * collects them; `null` on every other row.
   */
  prepaidPeriods: number | null;
}

export interface PlanExampleTimelineResult extends ExampleTimelineResult {
  periods: PlanExampleTimelinePeriod[];
}

export { TRAILING_REGULAR_PERIODS, MAX_TIMELINE_PERIODS, REPEATED_CYCLE_ITERATIONS };

const NO_CADENCE_REASON = 'Configure a billing frequency to preview an example timeline.';

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Projects the Plan's own lifecycle one billing period per row:
 * Free → Pre-paid → Pay → Bonus → Pay (regular), each row classified by
 * `classifyPlanDurationPeriod()` at its start date.
 *
 * A Plan with no durations at all is not a special case: it is
 * `TRAILING_REGULAR_PERIODS` rows of `pay_regular`.
 */
export function computePlanExampleTimeline(input: PlanExampleTimelineInput): PlanExampleTimelineResult {
  const { cadence, priceInclTax } = input;
  const anchor = (input.anchorDate ?? new Date().toISOString().slice(0, 10)).slice(0, 10);
  // #892 — one period length for both halves of a row: the durations are
  // counted in the same cadence the rows step by.
  const duration = cadence ? withDurationCadence(input.duration, cadence) : input.duration;

  return walkExampleTimeline({
    cadence,
    anchorDate: anchor,
    // #1130 — when the Plan's Auto Renew is on, the stopping rule is two
    // complete iterations of the configured cycle rather than two trailing
    // regular periods, because such a contract never reaches one. The decision
    // is the duration's (`repeats`), never re-derived here.
    cycle: timelineCycleFor(duration),
    reasonWhenNoCadence: NO_CADENCE_REASON,
    priceOn: (startsOn) => {
      const status = classifyPlanDurationPeriod(duration, anchor, startsOn);
      // #946 — the Pre-paid Duration is paid, not waived, and it is paid on the
      // first of its periods. `prepaidPeriodsDueOn()` is the one place that says
      // so; the row simply multiplies the price it was handed.
      const prepaidPeriods = prepaidPeriodsDueOn(duration, anchor, startsOn) || null;
      const waived = prepaidPeriods == null && planDurationWaivesFee(status);
      const amount = prepaidPeriods != null && priceInclTax != null
        ? round2(priceInclTax * prepaidPeriods)
        : priceInclTax;
      return { status, amount, waived, prepaidPeriods, regular: status === 'pay_regular' };
    },
  }) as PlanExampleTimelineResult;
}
