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
import { PlanDurationCadence, PlanDurationStatus } from './planDuration';
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
  /** Rendered verbatim by the caller when `cadence` is null. */
  reasonWhenNoCadence: string;
  priceOn: (startsOn: string, index: number) => ExampleTimelinePricedPeriod;
}

/**
 * Steps one row per billing period from `anchorDate`, asking the adapter what
 * each one costs, and stops `TRAILING_REGULAR_PERIODS` regular periods after
 * everything configured has run out (or at `MAX_TIMELINE_PERIODS`).
 *
 * The final row is open-ended (`endsOn: null`) only when it is a regular one:
 * the row budget can end while a configured duration is still running, and
 * "Bonus, from 24 Nov onwards" would be a lie.
 */
export function walkExampleTimeline(input: ExampleTimelineWalkInput): ExampleTimelineResult {
  const { cadence } = input;
  if (!cadence || !Number.isInteger(Number(cadence.interval)) || Number(cadence.interval) < 1) {
    return {
      available: false, reason: input.reasonWhenNoCadence, currency: 'EUR', anchorDate: null, periods: [],
    };
  }

  const anchor = input.anchorDate.slice(0, 10);
  const interval = Number(cadence.interval);
  const firstPeriod = Math.max(1, Math.trunc(input.firstPeriod ?? 1) || 1);
  const periods: ExampleTimelinePeriod[] = [];
  let cursor = (input.startOn ?? anchor).slice(0, 10);
  let regularShown = 0;

  while (regularShown < TRAILING_REGULAR_PERIODS && periods.length < MAX_TIMELINE_PERIODS) {
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
  if (last && regularShown === TRAILING_REGULAR_PERIODS) last.endsOn = null;

  return { available: true, reason: null, currency: 'EUR', anchorDate: anchor, periods };
}
