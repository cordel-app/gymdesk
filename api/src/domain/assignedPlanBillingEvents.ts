// #511 (stage 3 — Expanded detail + Billing Events endpoint).
//
// Pure calculation of the "Billing Events" view for a single Assigned Plan
// (`user_memberships` row), per the issue #511 thread's Q2 answer:
//
//   - Show ALL billing events affected by promotions applied to the plan,
//     PLUS the billing events covering the following two additional
//     calendar months after the last promotion-affected event.
//   - If the plan has no applicable promotions, show billing events
//     covering the next two calendar months from the relevant billing
//     start date.
//   - For a `draft` plan (no persisted billing events yet), compute the
//     same range as a non-persisted projection.
//   - For a submitted plan, query the actual persisted `billing_events`
//     rows within that calculated range.
//   - Ordered chronologically, scoped to this plan, no duplicates, no
//     fabricated placeholders, fewer events if the plan ends early.
//
// No DB access here — this module only turns already-fetched, already
// date-normalized (YYYY-MM-DD) inputs into a range + event list, so it's
// unit-testable without `createTestGym`/`db` (see CLAUDE.md's unit-vs-
// integration test guidance). `api/src/api/user-memberships.ts` does the
// DB reads/writes and date normalization around it.

import { advanceBillingDate } from './billingDate';
import { resolveMembershipFee } from './billingSimulation';
import { NO_PERSONAL_FEE_BENEFIT, PersonalFeeBenefit } from './personalFeeBenefit';
import { NO_PLAN_DURATION, PlanDuration } from './planDuration';
import {
  AppliedPromotionForBilling,
  MembershipFeeBenefit,
  PromotionApplicationWindow,
  promotionCoversDate,
} from './promotionApplication';

// Declared in `promotionApplication.ts` since #635 stage 12 (see that module
// for why), and re-exported here so every caller that has always imported them
// from this one keeps working.
export {
  AppliedPromotionForBilling,
  MembershipFeeBenefit,
  PromotionApplicationWindow,
  promotionCoversDate,
};

export type BillingUnit = 'day' | 'week' | 'month' | 'year';

// How many calendar months of billing events to show after the last one
// affected by a promotion (or after the billing start date, if none apply).
// Fixed by the issue thread's Q2 answer — not configurable per gym/plan.
const MONTHS_AFTER_LAST_PROMOTION = 2;

// Safety cap on how far into the future the *draft* projection will ever
// generate cycles. An applied promotion with an indefinite (no
// duration_months) Membership Fee benefit that's never revoked has no
// natural end date to project from, which would otherwise push the "2
// months after the last promotion-affected event" boundary forward forever.
// The issue thread doesn't specify a horizon for this case; 36 months
// comfortably covers every billing cadence in practice (daily/weekly/
// monthly/yearly) while keeping the loop bounded.
const MAX_PROJECTION_MONTHS = 36;

/** Adds `months` calendar months to a YYYY-MM-DD date string. */
export function addCalendarMonths(dateStr: string, months: number): string {
  return advanceBillingDate(dateStr, months, 'month');
}

function clampToEndsAt(dateStr: string, endsAt: string | null): string {
  return endsAt != null && endsAt < dateStr ? endsAt : dateStr;
}

/**
 * The assignment's own contract, for the paths that have one: its anchor and
 * its Billing & Duration, whose Free Period and Bonus Duration waive the
 * Membership Fee where no Promotion governs the date (#635 stage 8).
 *
 * Optional because a caller that only has a Promotion window (the persisted
 * ledger's tagging) has no use for it — omitted, nothing is waived by the Plan.
 */
export interface AssignmentDurationContext {
  startsAt: string;
  planDuration: PlanDuration;
  /**
   * #772 — the assignment's own Personal Membership Fee Benefit. Unlike the
   * durations beside it this one is not a *window*, so a caller that has the
   * assignment must pass it even when nothing else about the contract matters:
   * it discounts every cycle, including the ones no Promotion and no duration
   * touches.
   */
  personalFeeBenefit: PersonalFeeBenefit;
}

/**
 * What the Membership Fee actually costs on `atDate` — `resolveMembershipFee`
 * (`billingSimulation.ts`) and nothing else, so the Billing Events projection
 * cannot disagree with the Billing Simulation, My Membership or the nightly run.
 *
 * Until #635 stage 12 this module had its own rule: a Promotion's Membership Fee
 * Benefit applied for as long as the application stood, gated only by its own
 * `duration_months`. A Promotion whose promotional months had elapsed therefore
 * kept discounting every later cycle here, while the simulation had already
 * stopped it at the end of the Promotion's Free/Paid/Bonus timeline — the
 * thread's stage 12 answer (a). Free and Bonus promotional months were likewise
 * not waived at all in this projection. Both now come from the shared resolver.
 *
 * `promotionAffected` keeps its meaning — did an *applied Promotion* change this
 * charge (whatever the net effect)? — because the range rule (#511 Q2) extends
 * from the last promotion-affected event. A cycle the *Plan's* own Free Period
 * waives is not promotion-affected: it is the contract's regular shape.
 */
export function computeMembershipFeePriceAt(
  basePrice: number,
  atDate: string,
  promotions: AppliedPromotionForBilling[],
  assignment?: AssignmentDurationContext,
): { price: number; promotionAffected: boolean } {
  const resolved = resolveMembershipFee(basePrice, atDate, {
    // With no Billing & Duration to apply, the anchor is irrelevant —
    // `NO_PLAN_DURATION` classifies every date as `pay_regular`.
    startsAt: assignment?.startsAt ?? atDate,
    planDuration: assignment?.planDuration ?? NO_PLAN_DURATION,
    personalFeeBenefit: assignment?.personalFeeBenefit ?? NO_PERSONAL_FEE_BENEFIT,
    promotions,
  });
  return {
    price: resolved.amount,
    promotionAffected: resolved.benefits.some((b) => b.source === 'promotion'),
  };
}

/**
 * The shared range rule (#511 Q2): from the last date in
 * `promotionAffectedDates` (if any), extend `MONTHS_AFTER_LAST_PROMOTION`
 * calendar months; otherwise extend that many months from `billingStart`.
 * Clamped to the plan's `endsAt` when it ends before the full range.
 */
export function computeRangeEnd(
  promotionAffectedDates: string[],
  billingStart: string,
  endsAt: string | null,
): string {
  const last = promotionAffectedDates.length > 0
    ? promotionAffectedDates.reduce((a, b) => (a > b ? a : b))
    : null;
  return clampToEndsAt(addCalendarMonths(last ?? billingStart, MONTHS_AFTER_LAST_PROMOTION), endsAt);
}

export interface ProjectedBillingEvent {
  date: string;
  amount: number;
  promotion_affected: boolean;
  projected: true;
}

export interface DraftProjectionInput {
  billingStart: string;
  endsAt: string | null;
  basePrice: number;
  recurringInterval: number | null;
  recurringUnit: BillingUnit | null;
  /** Only currently-applied promotions — a draft's revoked promotions have no future effect. */
  promotions: AppliedPromotionForBilling[];
  /**
   * #635 stage 12 — the assignment's own Billing & Duration, so a Free Period or
   * Bonus Duration shows €0 here exactly as it does in the Billing Simulation
   * and as the nightly run waives it. Omitted for an assignment that has none.
   */
  assignment?: AssignmentDurationContext;
}

export interface BillingEventsView<E> {
  available: boolean;
  reason: string | null;
  projected: boolean;
  range_start: string | null;
  range_end: string | null;
  events: E[];
}

/**
 * Drafts never write to `billing_events` (#511 Q1) — this projects what the
 * range would look like from the plan's recurring billing cadence and its
 * currently-applied promotions, without persisting anything.
 */
export function projectDraftBillingEvents(input: DraftProjectionInput): BillingEventsView<ProjectedBillingEvent> {
  const { billingStart, endsAt, basePrice, recurringInterval, recurringUnit, promotions, assignment } = input;
  if (recurringInterval == null || recurringUnit == null) {
    return {
      available: false,
      reason: 'Configure a billing frequency to preview upcoming billing events.',
      projected: true, range_start: null, range_end: null, events: [],
    };
  }

  const cap = addCalendarMonths(billingStart, MAX_PROJECTION_MONTHS);
  let cursor = billingStart;
  let boundary = addCalendarMonths(billingStart, MONTHS_AFTER_LAST_PROMOTION);
  const cycles: ProjectedBillingEvent[] = [];

  // Generates one billing cycle at a time, pushing the boundary forward
  // whenever a cycle turns out to be promotion-affected, and stopping once
  // the cursor reaches the (possibly-pushed) boundary or the safety cap —
  // see MAX_PROJECTION_MONTHS above for why the cap exists.
  while (true) {
    cursor = advanceBillingDate(cursor, recurringInterval, recurringUnit);
    if (endsAt && cursor > endsAt) break;
    const { price, promotionAffected } = computeMembershipFeePriceAt(basePrice, cursor, promotions, assignment);
    if (promotionAffected) boundary = addCalendarMonths(cursor, MONTHS_AFTER_LAST_PROMOTION);
    cycles.push({ date: cursor, amount: price, promotion_affected: promotionAffected, projected: true });
    if (cursor >= boundary || cursor >= cap) break;
  }

  const rangeEnd = clampToEndsAt(boundary, endsAt);
  return {
    available: true, reason: null, projected: true,
    range_start: billingStart, range_end: rangeEnd,
    events: cycles.filter((c) => c.date <= rangeEnd),
  };
}

export interface PersistedBillingEventLike {
  date: string; // event's own date, e.g. created_at normalized to YYYY-MM-DD
}

export interface PersistedRangeInput<T extends PersistedBillingEventLike> {
  billingStart: string;
  endsAt: string | null;
  /** Every promotion ever applied to this plan (applied or revoked) — used only to tag/scope, never to recompute amounts. */
  promotionWindows: PromotionApplicationWindow[];
  /** Every persisted billing_events row for this plan, any date — filtered/tagged here, never fetched pre-filtered by SQL date range (so range_end can depend on the tagging itself). */
  events: T[];
}

/**
 * Submitted plans never get a projection — this only ever tags and filters
 * rows that already exist in `billing_events`, preserving their stored
 * (historical) values untouched, per #511 Q2's "never fabricate placeholder
 * records" / "preserve historical values" requirements.
 */
export function selectPersistedBillingEventsInRange<T extends PersistedBillingEventLike>(
  input: PersistedRangeInput<T>,
): BillingEventsView<T & { promotion_affected: boolean; projected: false }> {
  const { billingStart, endsAt, promotionWindows, events } = input;
  const tagged = events.map((e) => ({
    ...e,
    promotion_affected: promotionWindows.some((w) => promotionCoversDate(w, e.date)),
    projected: false as const,
  }));
  const affectedDates = tagged.filter((e) => e.promotion_affected).map((e) => e.date);
  const rangeEnd = computeRangeEnd(affectedDates, billingStart, endsAt);
  const inRange = tagged
    .filter((e) => e.date >= billingStart && e.date <= rangeEnd)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return {
    available: true, reason: null, projected: false,
    range_start: billingStart, range_end: rangeEnd,
    events: inRange,
  };
}
