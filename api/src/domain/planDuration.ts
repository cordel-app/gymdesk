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
// (`pay_beforehand_months`, migration 189) — the thread's "pre-paid duration
// which will flag in the simulation as pre-paid - no charge". It is the
// Promotion's own `pay_beforehand_months` (migration 141) with the same
// meaning: the first N of the Paid Duration's months are already paid up
// front, so they charge no Membership Fee even though they sit inside the
// paid stretch:
//
//     |<- free ->|<- prepaid ->|<---- paid ---->|<- bonus ->|<- regular, open-ended
//        waived      no charge    regular price     waived        regular price
//
// The month arithmetic itself is not duplicated: it is `advanceBillingDate`,
// the same helper every billing projection advances with.

import { advanceBillingDate } from './billingDate';

/**
 * Which period of the Plan's own Billing & Duration a date falls in. The names
 * differ from `PromotionTimelineStatus`'s on purpose: a line saying "free
 * period" has to say whose, and the two can appear in the same simulation.
 */
export type PlanDurationStatus = 'free_plan' | 'prepaid_plan' | 'pay_plan' | 'bonus_plan' | 'pay_regular';

/** A Plan's (or an assignment's frozen) Billing & Duration, normalized. */
export interface PlanDuration {
  freeMonths: number;
  paidMonths: number;
  bonusMonths: number;
  /** Of `paidMonths`, how many are already paid up front (stage 13). */
  prepaidMonths: number;
}

/** "Never configured" — also what a NULL/0 column set normalizes to. */
export const NO_PLAN_DURATION: PlanDuration = { freeMonths: 0, paidMonths: 0, bonusMonths: 0, prepaidMonths: 0 };

/**
 * Normalizes the nullable `free_months` / `paid_months` / `bonus_months` /
 * `pay_beforehand_months` columns. NULL ("never configured") and 0 both mean
 * "no such period" for billing purposes — the distinction only matters to the
 * editor, which reads the raw columns.
 *
 * `pay_beforehand_months` is clamped to `paid_months`, exactly as
 * `computePromotionTimeline` clamps the Promotion's: the API validates the
 * bound on write, and a row that predates the validation (or was edited
 * straight in the DB) must not be able to prepay months the contract never
 * had.
 */
export function toPlanDuration(
  freeMonths: unknown, paidMonths: unknown, bonusMonths: unknown, prepaidMonths?: unknown,
): PlanDuration {
  const months = (v: unknown) => Math.max(0, Math.trunc(Number(v)) || 0);
  const paid = months(paidMonths);
  return {
    freeMonths: months(freeMonths),
    paidMonths: paid,
    bonusMonths: months(bonusMonths),
    prepaidMonths: Math.min(months(prepaidMonths), paid),
  };
}

/**
 * The periods in which the Plan itself charges no Membership Fee: the Free
 * Period and the Bonus Duration waive it, and a Pre-paid month has already
 * been paid — it bills nothing further, which is the "pre-paid - no charge"
 * line the simulation draws for it (stage 13).
 */
export function planDurationWaivesFee(status: PlanDurationStatus): boolean {
  return status === 'free_plan' || status === 'bonus_plan' || status === 'prepaid_plan';
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
 * A date before `startsAt` is `pay_regular`: nothing is waived before the
 * contract it belongs to starts.
 */
export function classifyPlanDurationPeriod(
  duration: PlanDuration, startsAt: string, date: string,
): PlanDurationStatus {
  if (date < startsAt) return 'pay_regular';
  const { freeMonths, paidMonths, bonusMonths, prepaidMonths } = duration;
  if (date < advanceBillingDate(startsAt, freeMonths, 'month')) return 'free_plan';
  // The prepaid months are the *first* of the paid ones — the same slice
  // `computePromotionTimeline` draws as Prepaid before it draws Pay.
  if (date < advanceBillingDate(startsAt, freeMonths + prepaidMonths, 'month')) return 'prepaid_plan';
  if (date < advanceBillingDate(startsAt, freeMonths + paidMonths, 'month')) return 'pay_plan';
  if (date < advanceBillingDate(startsAt, freeMonths + paidMonths + bonusMonths, 'month')) return 'bonus_plan';
  return 'pay_regular';
}
