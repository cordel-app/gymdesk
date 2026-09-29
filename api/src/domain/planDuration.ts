// #635 stage 8 (§7 + the thread's Q2 answer) — what a Membership Plan's own
// **Billing & Duration** does to the Membership Fee.
//
// Stage 1 gave a Membership Plan `free_months` / `paid_months` / `bonus_months`
// (migration 173) and stage 2 froze them onto every assignment (migration 174),
// but nothing read them: an assignment with a one-month Free Period was billed
// its full fee from day one. §7 asks for "the same semantics as the Promotion
// configuration", which is the Free → Paid → Bonus → Regular timeline
// `promotionTimeline.ts` already projects for a Promotion:
//
//     |<- free ->|<-------- paid -------->|<- bonus ->|<- regular, open-ended
//        waived          regular price        waived        regular price
//
// This module is that classification and nothing else — pure, no DB, no HTTP,
// so it is unit-testable without `createTestGym` (CLAUDE.md). It is deliberately
// *not* `computePromotionTimeline` with zeroed Promotion fields:
//
//   - a Promotion's timeline is an **illustration** anchored on the first of the
//     anchor month, because the Promotions screen previews an unsaved config
//     against a hypothetical enrollment. A Plan's durations apply to a real
//     assignment, whose billing dates are its own `starts_at` — snapping them
//     to the first of that month would make a plan starting on the 31st free
//     for 30 days it was never given;
//   - a Plan carries no Membership Fee Benefit (§6), so the benefit-bearing
//     Billing column has no counterpart here.
//
// #635 stage 13 adds the fourth field, **Pre-paid Duration**
// (`pay_beforehand_periods`, migration 189) — the thread's "pre-paid duration
// which will flag in the simulation as pre-paid - no charge". It is the
// Promotion's own `pay_beforehand_months` (migration 141) with the same
// meaning: the first N of the Paid Duration's periods are already paid up
// front, so they charge no Membership Fee even though they sit inside the
// paid stretch:
//
//     |<- free ->|<- prepaid ->|<---- paid ---->|<- bonus ->|<- regular, open-ended
//        waived      no charge    regular price     waived        regular price
//
// ── #892: a duration is a count of *Billing Frequency periods* ───────────────
//
// Until #892 every boundary here was stepped as `advanceBillingDate(startsAt,
// n, 'month')`, with the unit hard-coded: the rows of a Plan's timeline
// advanced by its Billing Frequency while its statuses advanced by the
// calendar, so a Plan billing every 4 weeks with "Paid Duration 2" ran its paid
// stretch for two calendar months and charged on a 28-day cycle. #892 settles
// that the other way, for the run as well as the preview:
//
//     > A Membership Plan duration is a count of periods of its configured
//     > Billing Frequency.
//
// So the cadence is part of the duration value itself (`PlanDuration.cadence`)
// rather than a parameter a caller may forget — the same reason
// `MembershipFeeContext.personalFeeBenefit` is required (#772). `2` on a
// 4-weekly Plan is 2 × 28 days; on a monthly Plan it is 2 calendar months,
// which is what it has always been, so no Plan on the Month cadence changes
// what it bills. Migration 201 renames the columns to match
// (`free_periods` / `paid_periods` / `pay_beforehand_periods` /
// `bonus_periods`) on `membership_plans` and on every assignment's frozen
// snapshot; the stored *numbers* are untouched (§6: changing the frequency
// changes the unit, never the value).
//
// A **Promotion's** durations are deliberately not part of this:
// `promotionTimeline.ts` keeps its own calendar-month semantics, because a
// Promotion has no cadence of its own (its ticket says so explicitly).
//
// The period arithmetic itself is not duplicated: it is `advanceBillingDate`,
// the same helper every billing projection advances with.

import { BillingDateUnit, advanceBillingDate } from './billingDate';

/**
 * Which period of the Plan's own Billing & Duration a date falls in. The names
 * differ from `PromotionTimelineStatus`'s on purpose: a line saying "free
 * period" has to say whose, and the two can appear in the same simulation.
 */
export type PlanDurationStatus = 'free_plan' | 'prepaid_plan' | 'pay_plan' | 'bonus_plan' | 'pay_regular';

/**
 * The length of one period — the Plan's (or the assignment's frozen)
 * `(recurring_billing_interval, recurring_billing_unit)` pair. A cadence
 * outside #820's two choices is stepped exactly as stored: it is still what the
 * Plan bills on.
 */
export interface PlanDurationCadence {
  interval: number;
  unit: BillingDateUnit;
}

/**
 * What a Plan or assignment with no `billing_policies` row counts in. `1 month`
 * is the documented fallback everywhere a cadence is missing
 * (`DEFAULT_BILLING_POLICY`, `ASSIGNMENT_CADENCE`'s own callers), and it is
 * what every duration meant before #892 — so a row that has never had a
 * billing policy is classified exactly as it was.
 */
export const DEFAULT_PLAN_DURATION_CADENCE: PlanDurationCadence = { interval: 1, unit: 'month' };

/**
 * A Plan's (or an assignment's frozen) Billing & Duration, normalized: four
 * counts **and the cadence one count is a period of**. The two are one value
 * because they are meaningless apart — "Paid Duration 2" says nothing until the
 * Billing Frequency says what a 2 is (#892).
 */
export interface PlanDuration {
  freePeriods: number;
  paidPeriods: number;
  bonusPeriods: number;
  /** Of `paidPeriods`, how many are already paid up front (stage 13). */
  prepaidPeriods: number;
  cadence: PlanDurationCadence;
}

/** "Never configured" — also what a NULL/0 column set normalizes to. */
export const NO_PLAN_DURATION: PlanDuration = {
  freePeriods: 0, paidPeriods: 0, bonusPeriods: 0, prepaidPeriods: 0,
  cadence: DEFAULT_PLAN_DURATION_CADENCE,
};

/**
 * Normalizes a stored cadence pair. A missing, zero, fractional or negative
 * interval, or a unit outside the four `billing_policies` allows, is not a
 * cadence anything can be stepped by — it falls back to `1 month`, the same
 * answer a row with no billing policy at all gets.
 */
export function toPlanDurationCadence(interval: unknown, unit: unknown): PlanDurationCadence {
  const n = Math.trunc(Number(interval));
  const known = unit === 'day' || unit === 'week' || unit === 'month' || unit === 'year';
  if (!Number.isFinite(n) || n < 1 || !known) return DEFAULT_PLAN_DURATION_CADENCE;
  return { interval: n, unit: unit as BillingDateUnit };
}

/**
 * Normalizes the nullable `free_periods` / `paid_periods` / `bonus_periods` /
 * `pay_beforehand_periods` columns against the cadence they are counted in.
 * NULL ("never configured") and 0 both mean "no such period" for billing
 * purposes — the distinction only matters to the editor, which reads the raw
 * columns.
 *
 * The cadence is a required argument rather than an optional one: a pricing
 * path that forgot it would silently count a 4-weekly Plan's durations in
 * calendar months, which is precisely the defect #892 removes.
 *
 * `pay_beforehand_periods` is clamped to `paid_periods`, exactly as
 * `computePromotionTimeline` clamps the Promotion's: the API validates the
 * bound on write, and a row that predates the validation (or was edited
 * straight in the DB) must not be able to prepay periods the contract never
 * had.
 */
export function toPlanDuration(
  freePeriods: unknown,
  paidPeriods: unknown,
  bonusPeriods: unknown,
  prepaidPeriods: unknown,
  cadence: PlanDurationCadence,
): PlanDuration {
  const count = (v: unknown) => Math.max(0, Math.trunc(Number(v)) || 0);
  const paid = count(paidPeriods);
  return {
    freePeriods: count(freePeriods),
    paidPeriods: paid,
    bonusPeriods: count(bonusPeriods),
    prepaidPeriods: Math.min(count(prepaidPeriods), paid),
    cadence: toPlanDurationCadence(cadence?.interval, cadence?.unit),
  };
}

/**
 * The same counts, counted in a different cadence. The Example timeline needs
 * it: it is handed a Plan's durations and the Plan's cadence separately (a
 * Plan with no billing policy has no timeline at all), and rebinding here is
 * what keeps the rows it steps and the statuses it classifies from being able
 * to disagree about the period length.
 *
 * It changes the unit, never the numbers — §6 of the ticket, in code.
 */
export function withDurationCadence(duration: PlanDuration, cadence: PlanDurationCadence): PlanDuration {
  return { ...duration, cadence: toPlanDurationCadence(cadence?.interval, cadence?.unit) };
}

/**
 * The periods in which the Plan itself charges no Membership Fee: the Free
 * Period and the Bonus Duration waive it, and a Pre-paid period has already
 * been paid — it bills nothing further, which is the "pre-paid - no charge"
 * line the simulation draws for it (stage 13).
 */
export function planDurationWaivesFee(status: PlanDurationStatus): boolean {
  return status === 'free_plan' || status === 'bonus_plan' || status === 'prepaid_plan';
}

/**
 * `startsAt` advanced by `periods` of the duration's own cadence — the one
 * place a count of periods becomes a date.
 */
function boundary(duration: PlanDuration, startsAt: string, periods: number): string {
  const { interval, unit } = duration.cadence;
  return advanceBillingDate(startsAt, periods * interval, unit);
}

/**
 * Which period `date` falls in, counted from the assignment's start date.
 *
 * Every boundary is measured from `startsAt` in a single step
 * (`startsAt + free`, `startsAt + free + paid`, …) rather than by chaining
 * additions: `advanceBillingDate` clamps end-of-month overflow the way
 * `Date.setUTCMonth` does (31 Jan + 1 month = 3 Mar), and chaining would let
 * that drift accumulate and — with a long enough Free Period — push a later
 * boundary *before* an earlier one. Measured from the anchor, the boundaries
 * are always in order.
 *
 * Each boundary is `n × the Plan's Billing Frequency` (#892), so for a 4-weekly
 * Plan a Free Period of 3 ends after 84 days, not after three calendar months.
 *
 * A date before `startsAt` is `pay_regular`: nothing is waived before the
 * contract it belongs to starts.
 */
export function classifyPlanDurationPeriod(
  duration: PlanDuration, startsAt: string, date: string,
): PlanDurationStatus {
  if (date < startsAt) return 'pay_regular';
  const { freePeriods, paidPeriods, bonusPeriods, prepaidPeriods } = duration;
  if (date < boundary(duration, startsAt, freePeriods)) return 'free_plan';
  // The prepaid periods are the *first* of the paid ones — the same slice
  // `computePromotionTimeline` draws as Prepaid before it draws Pay.
  if (date < boundary(duration, startsAt, freePeriods + prepaidPeriods)) return 'prepaid_plan';
  if (date < boundary(duration, startsAt, freePeriods + paidPeriods)) return 'pay_plan';
  if (date < boundary(duration, startsAt, freePeriods + paidPeriods + bonusPeriods)) return 'bonus_plan';
  return 'pay_regular';
}
