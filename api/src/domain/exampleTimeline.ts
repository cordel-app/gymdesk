// #924 stage 3 — the Example Timeline projection, shared by the Membership
// Plan card and the Assigned Plan card.
//
// #818 built the table for a Plan: one row per billing period, with Period /
// Dates / Status / Billing, each row's status decided by the same rule the
// nightly run prices a cycle with. §7 of #924 asks for the same table on an
// Assigned Plan — "using the same simulation logic and presentation as
// Membership Plans" — so what the two share moves here and each entity keeps
// only the adapter that says how one of its periods is priced:
//
//     planExampleTimeline.ts        ──┐
//                                     ├──▶ walkExampleTimeline()
//     assignmentExampleTimeline.ts  ──┘
//
// exactly as #922 did for the Billing Event Simulation
// (`billingEventSimulation.ts` plus one adapter per entity). The walk owns the
// period stepping, the horizon and the open-ended final row; it owns **no**
// pricing and **no** classification, which stay with `resolveMembershipFee()`
// and `classifyPlanDurationPeriod()` — a second place deciding which period is
// Free / Pre-paid / Pay / Bonus is the thing CLAUDE.md forbids.
//
// Nothing here is persisted and nothing here charges.

import { advanceBillingDate } from './billingDate';
import {
  PlanDuration,
  PlanDurationCadence,
  PlanDurationStatus,
  planDurationCycleLength,
} from './planDuration';
import { PromotionTimelineStatus } from './promotionTimeline';

/**
 * What a row's Status column names. A Plan's own Billing & Duration
 * (`free_plan`, …) or — on an assignment, where an applied Promotion outranks
 * it (#635's Q2 answer) — that Promotion's own period (`free_promotion`, …).
 */
export type ExampleTimelineStatus = PlanDurationStatus | PromotionTimelineStatus;

export interface ExampleTimelinePeriod {
  period: number;
  status: ExampleTimelineStatus;
  startsOn: string; // YYYY-MM-DD
  /** `null` on the final row when it is open-ended — billing continues. */
  endsOn: string | null;
  /**
   * What this period charges, VAT included: `null` for a period nothing is
   * owed on (`waived`) and `null` too when there is no price to quote at all.
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

export interface ExampleTimelineResult {
  available: boolean;
  /** Why there is no timeline. Each adapter's own wording. */
  reason: string | null;
  currency: 'EUR';
  /** The date the periods were counted from. */
  anchorDate: string | null;
  periods: ExampleTimelinePeriod[];
  /**
   * #1130 stage 2 — the cycle the rows belong to, so the table can group them
   * and say whether it starts again. `null` for a contract with nothing
   * configured (there is no cycle to speak of) and on an unavailable
   * projection; it is `timelineCycleFor()`'s answer, reported rather than
   * re-derived, because which periods form one iteration and whether it
   * repeats are the engine's decisions and a second place deciding either is
   * how a table comes to group rows the run bills differently.
   */
  cycle: ExampleTimelineCycle | null;
}

/** What an adapter answers for one period, given the date it starts on. */
export interface ExampleTimelinePricedPeriod {
  status: ExampleTimelineStatus;
  amount: number | null;
  waived: boolean;
  prepaidPeriods: number | null;
  /**
   * This period is the contract's plain recurring charge — no Free Period, no
   * Pre-paid or Bonus Duration, no Promotion still governing it. It is what
   * ends the projection: the walk runs until `TRAILING_REGULAR_PERIODS` of
   * them have been shown, so the table always gets past whatever is configured
   * and shows the contract settling into its regular price.
   */
  regular: boolean;
}

/**
 * How many regular periods trail the configured ones. Two, per #818's thread
 * (Q5: "Free Period + Paid Duration + Bonus Duration + 2"): one alone reads
 * like the contract ends there, and the second is what shows it simply keeps
 * billing.
 */
export const TRAILING_REGULAR_PERIODS = 2;

/**
 * Upper bound on the rows a timeline may hold. The durations are free-form
 * numbers on the form; a Plan configured with 500 free periods must not turn a
 * card render into a 500-row table (or, for a weekly legacy cadence, a
 * multi-thousand-row one).
 */
export const MAX_TIMELINE_PERIODS = 60;

/**
 * #1130 — how many iterations of a **repeating** cycle the table shows.
 *
 * Two, per the ticket: "the simulation shows two complete cycles" and then
 * `↻ Repeats indefinitely`. One alone cannot show that the configured stretch
 * starts again, which is the whole thing the ticket is about, and more than two
 * repeats the same pattern for no new information.
 *
 * It replaces `TRAILING_REGULAR_PERIODS` as the stopping rule for such a
 * contract rather than joining it, because a repeating cycle **never reaches a
 * regular period** — the walk would otherwise run to `MAX_TIMELINE_PERIODS`
 * every time.
 */
export const REPEATED_CYCLE_ITERATIONS = 2;

/**
 * #1130 — the cycle this contract's Free -> Pre-paid -> Paid -> Bonus stretch
 * forms, and whether it starts again.
 *
 * `null` (or a zero `length`) is the contract with nothing configured: no
 * cycle, so the walk keeps the rule it has always had — run until
 * `TRAILING_REGULAR_PERIODS` regular periods have been shown — and the table
 * groups nothing. A cycle that **repeats** is the only one that changes the
 * stopping rule; stage 2 reports a non-repeating one too, because `1` beside
 * the configured stretch and `One cycle only` under it is exactly what a
 * non-renewing contract has to say.
 */
export interface ExampleTimelineCycle {
  /** Periods in one iteration — `planDurationCycleLength()`. */
  length: number;
  /**
   * Whether the iteration starts again — `PlanDuration.repeats`, never
   * re-derived. It is what decides the stopping rule below *and* which marker
   * the table prints beside its last row, so the two cannot disagree.
   */
  repeats: boolean;
  /**
   * How many iterations to show: `REPEATED_CYCLE_ITERATIONS` while it repeats,
   * `1` otherwise — a contract that runs its durations once has exactly one.
   */
  iterations: number;
}

/**
 * #1130 — the cycle to group the rows by (and, while it repeats, to bound the
 * walk by), or `null` for a contract with no configured durations at all. One
 * helper, shared by both adapters, so the two timelines cannot bound or group
 * themselves differently.
 */
export function timelineCycleFor(duration: PlanDuration): ExampleTimelineCycle | null {
  const length = planDurationCycleLength(duration);
  if (length <= 0) return null;
  return {
    length,
    repeats: duration.repeats,
    iterations: duration.repeats ? REPEATED_CYCLE_ITERATIONS : 1,
  };
}

/**
 * #1130 — how many periods `cycle.iterations` complete iterations span, bounded
 * by the row budget, or `null` for a cycle that does not repeat (there is
 * nothing to bound: such a contract settles into its regular price and the
 * trailing-regular rule finds it).
 *
 * It is the one place that number is decided, which is what makes #1130 §3's
 * "the two simulations should tell exactly the same story" structural rather
 * than a convention: the Membership Fee Simulation bounds its *rows* by it
 * below, and `timelineCycleHorizon()` turns the same count into the last date
 * the **Billing Event Simulation** runs to. A cycle longer than the budget is
 * clamped, exactly as the table has always clamped, so neither projection can
 * claim a span the other does not reach.
 */
export function timelineCyclePeriods(cycle: ExampleTimelineCycle | null | undefined): number | null {
  if (!cycle?.repeats) return null;
  const periods = Math.trunc(cycle.length) * Math.trunc(cycle.iterations);
  if (!(periods >= 1)) return null;
  return Math.min(periods, MAX_TIMELINE_PERIODS);
}

/**
 * #1130 stage 3 — the **last billing date** those periods reach, counted from
 * the first period a projection renders: `startOn + (periods - 1) x cadence`,
 * because a period is billed on the day it starts.
 *
 * `null` for a cycle that does not repeat, which is what leaves the Billing
 * Event Simulation's existing horizon rules (#629 §6's first regular charge,
 * #915's two-cycles-per-stream floor) exactly as they were for every contract
 * that existed before this ticket.
 *
 * `startOn` is the same date the fee table starts at — the contract's anchor for
 * a Plan preview, the period containing today for an assignment
 * (`periodContaining()`) — so the two sections of one card cover the same dates.
 */
export function timelineCycleHorizon(
  startOn: string,
  cadence: PlanDurationCadence,
  cycle: ExampleTimelineCycle | null | undefined,
): string | null {
  const periods = timelineCyclePeriods(cycle);
  if (periods == null) return null;
  return advanceBillingDate(startOn.slice(0, 10), (periods - 1) * cadence.interval, cadence.unit);
}

/**
 * Nothing stops a gym back-dating `starts_at`, so the walk to the current
 * period is bounded: 1200 periods is a century of monthly billing, and a row
 * set that cannot reach today is reported as it is rather than looped over.
 */
const MAX_ELAPSED_PERIODS = 1200;

/**
 * The period `date` falls in, counted from `startsAt`: where an existing
 * contract's projection starts and which period number that first row carries.
 * A contract that has not started yet begins at its own first period.
 *
 * It lives here rather than beside one adapter because since #1130 stage 3 both
 * of a card's projections need it — the fee table to know which period it is
 * starting at, and `timelineCycleHorizon()` to count the displayed iterations
 * from the same place.
 */
export function periodContaining(
  startsAt: string, date: string, cadence: PlanDurationCadence | null,
): { startOn: string; firstPeriod: number } {
  const anchor = startsAt.slice(0, 10);
  if (!cadence) return { startOn: anchor, firstPeriod: 1 };
  let cursor = anchor;
  let index = 0;
  while (index < MAX_ELAPSED_PERIODS) {
    const next = advanceBillingDate(cursor, cadence.interval, cadence.unit);
    if (next > date.slice(0, 10)) break;
    cursor = next;
    index++;
  }
  return { startOn: cursor, firstPeriod: index + 1 };
}

export interface ExampleTimelineWalkInput {
  /**
   * The length of one row — the Plan's, or the assignment's own, stored
   * `(recurring_billing_interval, recurring_billing_unit)` pair. A cadence
   * outside #820's two choices is stepped exactly as stored: it is still what
   * is billed. `null` is "no billing frequency configured" and there is no
   * timeline at all.
   */
  cadence: PlanDurationCadence | null;
  /**
   * The contract's own anchor — a Plan's hypothetical enrollment date, an
   * assignment's `starts_at`. Every period boundary is counted from it, and it
   * is what the result reports.
   */
  anchorDate: string;
  /**
   * Where the **first rendered row** starts, when that is not the anchor. An
   * Assigned Plan's periods are counted from a `starts_at` that may be years
   * back, and a table of elapsed cycles answers nothing: it starts at the
   * period containing today instead, with `firstPeriod` saying which one that
   * is. Defaults to `anchorDate`, which is what a Plan preview wants.
   */
  startOn?: string;
  /** The period number of that first row. Defaults to 1. */
  firstPeriod?: number;
  /**
   * #1130 — set when the contract's Free -> Pre-paid -> Paid -> Bonus stretch
   * repeats, which replaces the trailing-regular stopping rule: such a contract
   * has no regular period to trail.
   */
  cycle?: ExampleTimelineCycle | null;
  /** Rendered verbatim by the caller when `cadence` is null. */
  reasonWhenNoCadence: string;
  priceOn: (startsOn: string, index: number) => ExampleTimelinePricedPeriod;
}

/**
 * Steps one row per billing period from `anchorDate`, asking the adapter what
 * each one costs, and stops `TRAILING_REGULAR_PERIODS` regular periods after
 * everything configured has run out (or at `MAX_TIMELINE_PERIODS`).
 *
 * #1130 — unless the contract's cycle **repeats**, in which case it stops after
 * `cycle.iterations` complete iterations: there is no regular period to trail,
 * so the trailing rule would run every renewing Plan to the row budget.
 *
 * The final row is open-ended (`endsOn: null`) only when it is a regular one:
 * the row budget can end while a configured duration is still running, and
 * "Bonus, from 24 Nov onwards" would be a lie. A repeating cycle's last row is
 * therefore closed too — the cycle continues, and what says so is the
 * `↻ Repeats indefinitely` marker beside the table rather than an open-ended
 * Bonus period.
 */
export function walkExampleTimeline(input: ExampleTimelineWalkInput): ExampleTimelineResult {
  const { cadence } = input;
  if (!cadence || !Number.isInteger(Number(cadence.interval)) || Number(cadence.interval) < 1) {
    return {
      available: false,
      reason: input.reasonWhenNoCadence,
      currency: 'EUR',
      anchorDate: null,
      periods: [],
      cycle: null,
    };
  }

  const anchor = input.anchorDate.slice(0, 10);
  const interval = Number(cadence.interval);
  const firstPeriod = Math.max(1, Math.trunc(input.firstPeriod ?? 1) || 1);
  const periods: ExampleTimelinePeriod[] = [];
  let cursor = (input.startOn ?? anchor).slice(0, 10);
  let regularShown = 0;

  // #1130 — a repeating cycle's budget is its own iterations; everything else
  // keeps the trailing-regular rule, so `rowsWanted` is null there and the
  // loop condition below is the pre-ticket one. A cycle that does **not**
  // repeat is reported for the table to group by (stage 2) and bounds nothing:
  // its contract still settles into its regular price, and those trailing rows
  // are what say so.
  const cycle = input.cycle ?? null;
  const cycleLength = Math.max(0, Math.trunc(cycle?.length ?? 0) || 0);
  // The same count `timelineCycleHorizon()` turns into the Billing Event
  // Simulation's last date, so the two sections of one card span the same dates.
  const rowsWanted = timelineCyclePeriods(cycle);

  while (
    (rowsWanted != null ? periods.length < rowsWanted : regularShown < TRAILING_REGULAR_PERIODS)
    && periods.length < MAX_TIMELINE_PERIODS
  ) {
    const startsOn = cursor;
    const next = advanceBillingDate(startsOn, interval, cadence.unit);
    const priced = input.priceOn(startsOn, periods.length);
    if (priced.regular) regularShown++;
    periods.push({
      period: firstPeriod + periods.length,
      status: priced.status,
      startsOn,
      endsOn: advanceBillingDate(next, -1, 'day'),
      amount: priced.waived ? null : priced.amount,
      waived: priced.waived,
      prepaidPeriods: priced.prepaidPeriods,
    });
    cursor = next;
  }

  const last = periods[periods.length - 1];
  if (last && rowsWanted == null && regularShown === TRAILING_REGULAR_PERIODS) last.endsOn = null;

  return {
    available: true, reason: null, currency: 'EUR', anchorDate: anchor, periods, cycle: cycleLength > 0 ? cycle : null,
  };
}
