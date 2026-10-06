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
// ── #1130: the configured stretch is a *cycle*, and it may repeat ───────────
//
// Until #1130 this timeline ran once: after the Bonus Duration the contract
// billed its regular fee for ever (`pay_regular`, open-ended). `auto_renew`
// existed on `billing_policies`, was shown on the Plan card and was read by
// **nothing**. The ticket's answer (`Q1 real`) is that the four durations are
// one *cycle* and `auto_renew` is what decides whether it starts again:
//
//     auto_renew = 0   |<- free ->|<- prepaid ->|<- paid ->|<- bonus ->|<- regular, open-ended
//     auto_renew = 1   |<- free ->|<- prepaid ->|<- paid ->|<- bonus ->|<- free ->|<- prepaid ->| ...
//
// so with it on the contract never reaches `pay_regular` at all, and the
// Pre-paid lump is owed again at the start of every iteration (the thread's
// answer **B**). With it off nothing changes: the cycle runs once and the
// contract settles into its regular price without expiring (answer **C** —
// "one cycle only" is about the benefit cycle, never about billing stopping).
//
// Because this module is the one place that decides which period is
// Free/Pre-paid/Pay/Bonus and `resolveMembershipFee()` is the one place every
// surface prices a cycle through, the nightly run, `POST /payment-requests`,
// the Payments dashboard, `GET /me/membership` and both simulations start
// repeating at the same instant. There is no version of this that is only a
// preview — which is why `repeats` is a **required** field of `PlanDuration`,
// beside the cadence and for the cadence's reason (#892): a pricing path that
// could forget it would quietly charge a renewing contract the regular price
// from its second cycle on.
//
// Where the flag comes from is the other half of the answer, and it is not this
// module's: `repeats` is the assignment's **own** `user_memberships.auto_renew`
// (migration 230), snapshotted from the Plan at assignment time like every
// other commercial term (#635 §13/§17) and backfilled to 0, so no assignment
// that already exists has its billing moved by the deploy (answer **A**). The
// Plan's own previews read the Plan's live `billing_policies.auto_renew`,
// because a catalogue preview is about the Plan as it stands now.
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
  /**
   * #1130 — does the configured cycle start again when it ends? The
   * assignment's own frozen `auto_renew`, or a Plan's live one for a catalogue
   * preview. Required rather than optional for the reason `cadence` is: this is
   * what the contract bills, not a display preference.
   */
  repeats: boolean;
}

/** "Never configured" — also what a NULL/0 column set normalizes to. */
export const NO_PLAN_DURATION: PlanDuration = {
  freePeriods: 0, paidPeriods: 0, bonusPeriods: 0, prepaidPeriods: 0,
  cadence: DEFAULT_PLAN_DURATION_CADENCE,
  // Nothing is configured, so there is no cycle to repeat — and `repeats` with
  // a zero-length cycle is a no-op anyway (`planDurationCycleLength()` below).
  repeats: false,
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
 * #1130 — normalizes a stored `auto_renew` into the one boolean the classifier
 * reads. mysql2 serves a `TINYINT(1)` as `0`/`1`, but a caller may hand over a
 * real boolean (a Plan's own API shape) or a string from a driver configured
 * differently.
 *
 * Anything it cannot read as a number is **false**, and that direction is
 * deliberate: false is what every assignment written before migration 230
 * means and what the engine did before this ticket, so an unreadable value
 * costs the renewal rather than inventing one — the same way round as the
 * column's own `DEFAULT 0`.
 */
export function toPlanDurationRepeats(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (value == null || value === '') return false;
  const n = Number(value);
  return Number.isFinite(n) ? n !== 0 : false;
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
 * calendar months, which is precisely the defect #892 removes. `repeats`
 * (#1130) is required for the same reason, one ticket on: a path that forgot it
 * would bill a renewing contract its regular fee from the second cycle while
 * the surface beside it showed the cycle starting again.
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
  repeats: unknown,
): PlanDuration {
  const count = (v: unknown) => Math.max(0, Math.trunc(Number(v)) || 0);
  const paid = count(paidPeriods);
  return {
    freePeriods: count(freePeriods),
    paidPeriods: paid,
    bonusPeriods: count(bonusPeriods),
    prepaidPeriods: Math.min(count(prepaidPeriods), paid),
    cadence: toPlanDurationCadence(cadence?.interval, cadence?.unit),
    // #1130 — required for the reason `cadence` is: a caller that could omit it
    // would silently stop a renewing contract's cycle after its first pass.
    repeats: toPlanDurationRepeats(repeats),
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
  // #1130 — `repeats` rides along with the counts, because rebinding the unit a
  // period is measured in says nothing about whether the cycle starts again.
  return { ...duration, cadence: toPlanDurationCadence(cadence?.interval, cadence?.unit) };
}

/**
 * The periods in which the Plan itself charges no *recurring* Membership Fee:
 * the Free Period and the Bonus Duration waive it, and a Pre-paid period has
 * already been paid — it bills nothing further, which is the "pre-paid - no
 * charge" line the simulation draws for it (stage 13).
 *
 * "Already been paid" is the whole of what a Pre-paid period means, and #946 is
 * where the money that pays for it appears: the Pre-paid Duration is collected
 * **up front, in one charge, on the first of those periods**
 * (`prepaidPeriodsDueOn()`). So a prepaid period waives the recurring fee, but
 * the first one is not a free period — ask `prepaidPeriodsDueOn()` before
 * concluding that a prepaid period charges nothing at all.
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
 * #1130 — the length of one iteration of the configured cycle, in periods:
 * Free + Paid + Bonus. The Pre-paid Duration is deliberately **not** added,
 * because it is the first slice *of* the Paid Duration rather than a stretch
 * beside it (`toPlanDuration()` clamps it to `paidPeriods` for that reason), so
 * counting it would make every pre-paid contract's cycle too long.
 *
 * Zero means nothing is configured, and a zero-length cycle cannot repeat —
 * which is what keeps `repeats` a no-op for an assignment carrying no Billing &
 * Duration at all, rather than an infinite loop.
 */
export function planDurationCycleLength(duration: PlanDuration): number {
  return duration.freePeriods + duration.paidPeriods + duration.bonusPeriods;
}

/**
 * The upper bound on iterations `elapsedCycles()` will walk. A one-period
 * monthly cycle reaches it after ~100 years, so it cannot be hit by a date any
 * surface here produces (the Membership Fee Simulation caps at 60 periods and
 * the Billing Event Simulation at 36 months); it exists so that a corrupt
 * `starts_at` — a date from year 9999, a fixture a thousand cycles out — costs
 * a misclassified period rather than a hung request.
 */
const MAX_CYCLE_ITERATIONS = 1200;

/**
 * How many complete iterations of the cycle lie between `startsAt` and `date`.
 *
 * Always 0 when the cycle does not repeat or has no length, which is what makes
 * every caller below identical to its pre-#1130 self for such a duration.
 *
 * The walk steps iteration boundaries rather than dividing a month count,
 * because a boundary is `advanceBillingDate(startsAt, n x interval, unit)` and
 * that is not a linear function of `n` — it clamps end-of-month overflow (31
 * Jan + 1 month = 3 Mar), so the only way to know which iteration a date is in
 * is to ask the same helper every other boundary here is measured with.
 */
function elapsedCycles(duration: PlanDuration, startsAt: string, date: string): number {
  const cycleLength = planDurationCycleLength(duration);
  if (!duration.repeats || cycleLength < 1) return 0;
  let elapsed = 0;
  while (
    elapsed < MAX_CYCLE_ITERATIONS
    && boundary(duration, startsAt, (elapsed + 1) * cycleLength) <= date
  ) elapsed += 1;
  return elapsed;
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
 *
 * Since #1130 a duration whose `repeats` is set classifies `date` inside the
 * iteration of the cycle it actually falls in, so a `12 prepaid + 3 bonus`
 * contract reads Pre-paid again at period 16 rather than settling into its
 * regular price. With `repeats` off — every assignment that existed before
 * migration 230, and every Plan whose Auto Renew is unticked — the offset is
 * zero and this is the one-shot timeline it has always been.
 */
export function classifyPlanDurationPeriod(
  duration: PlanDuration, startsAt: string, date: string,
): PlanDurationStatus {
  if (date < startsAt) return 'pay_regular';
  const { freePeriods, paidPeriods, bonusPeriods, prepaidPeriods } = duration;
  // #1130 — zero when the cycle does not repeat, which is the pre-ticket
  // arithmetic to the letter; otherwise the periods the earlier iterations
  // consumed, so every boundary below is still a single step from the anchor.
  const offset = elapsedCycles(duration, startsAt, date) * planDurationCycleLength(duration);
  if (date < boundary(duration, startsAt, offset + freePeriods)) return 'free_plan';
  // The prepaid periods are the *first* of the paid ones — the same slice
  // `computePromotionTimeline` draws as Prepaid before it draws Pay.
  if (date < boundary(duration, startsAt, offset + freePeriods + prepaidPeriods)) return 'prepaid_plan';
  if (date < boundary(duration, startsAt, offset + freePeriods + paidPeriods)) return 'pay_plan';
  if (date < boundary(duration, startsAt, offset + freePeriods + paidPeriods + bonusPeriods)) return 'bonus_plan';
  // Unreachable for a repeating cycle of non-zero length: `offset` is chosen so
  // that `date` sits inside the iteration it opens, and the bonus boundary
  // above is where the next one begins. A renewing contract therefore never
  // settles into `pay_regular`, which is the whole of #1130's `Q1 real`.
  return 'pay_regular';
}

/**
 * #946 — how many Pre-paid periods the Membership Fee charged on `date` covers.
 *
 * The Pre-paid Duration is not a waiver. It says the member *has already paid*
 * for the first N periods of the Paid Duration, and until this ticket nothing
 * anywhere collected that money: every prepaid period priced at 0, so a Plan
 * sold with "3 months pre-paid" showed `Waived · €0.00` in the Billing Event
 * Simulation and — because `POST /payment-requests` refuses a cycle that owes
 * nothing — could not even raise its first payment.
 *
 * So the whole Pre-paid Duration is owed **on the first of its periods** —
 * once for a contract that does not renew, and once per iteration for one that
 * does (#1130 answer B):
 *
 *     |<- prepaid 1 ->|<- prepaid 2 ->|<- prepaid 3 ->|<- pay ->|
 *        3 x the fee       covered         covered      the fee
 *
 * which is the ticket's own example (`€70/month`, 3 pre-paid ⇒ `€210` in the
 * first billing event, then no Membership Fee until the fourth period).
 *
 * The answer is a count rather than an amount because an amount would be a
 * second implementation of what a cycle costs — the caller multiplies the
 * regular fee it has already resolved (`resolveMembershipFee()`), so an applied
 * Promotion's or a Personal Benefit's discount still reaches every period the
 * lump covers.
 *
 * It is keyed on the *period*, not on the exact billing date: anywhere inside
 * the first prepaid period the lump is what is owed. A date equality test would
 * mean a first payment raised a day after the assignment was created priced the
 * fee at 0 and was refused, which is the defect this ticket is fixing.
 *
 * `0` for every other date — no Pre-paid Duration, a date outside it, or one of
 * the periods the first charge already covers.
 */
export function prepaidPeriodsDueOn(
  duration: PlanDuration, startsAt: string, date: string,
): number {
  if (duration.prepaidPeriods < 1) return 0;
  if (classifyPlanDurationPeriod(duration, startsAt, date) !== 'prepaid_plan') return 0;
  // #1130 answer B — the lump is owed again at the start of *every* iteration,
  // so "the first prepaid period" is the first of the cycle `date` falls in.
  // `offset` is 0 for a contract that does not repeat, which is #946 unchanged.
  const offset = elapsedCycles(duration, startsAt, date) * planDurationCycleLength(duration);
  const secondPrepaidPeriod = boundary(duration, startsAt, offset + duration.freePeriods + 1);
  return date < secondPrepaidPeriod ? duration.prepaidPeriods : 0;
}
