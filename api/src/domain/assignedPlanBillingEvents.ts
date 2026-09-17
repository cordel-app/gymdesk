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

import { advanceBillingDate } from '../api/billing';
import { applyPeriodBenefit, PromotionBenefitAction } from './promotionBenefits';

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
 * The [applied, revoked] window during which a promotion affected billing.
 * `revokedAt: null` means still applied (or never revoked) — the window is
 * open-ended. Dates are plain YYYY-MM-DD strings (time-of-day is irrelevant
 * to which billing cycle/event a promotion did or didn't cover).
 */
export interface PromotionApplicationWindow {
  appliedAt: string;
  revokedAt: string | null;
}

/** Is `atDate` inside the window during which this promotion affected billing? */
export function promotionCoversDate(w: PromotionApplicationWindow, atDate: string): boolean {
  return w.appliedAt <= atDate && (w.revokedAt == null || w.revokedAt >= atDate);
}

/**
 * A single Membership Fee benefit contributed by an applied promotion.
 * Mirrors `computeFinalPrice()` in `membership-promotions.ts`: a Charge
 * Benefit applies for as long as the promotion's own window covers the
 * date; a Period Benefit additionally expires `durationMonths` after the
 * promotion's `appliedAt` (or never, if `durationMonths` is null).
 */
export type MembershipFeeBenefit =
  | { kind: 'charge'; action: PromotionBenefitAction; value: number | null }
  | { kind: 'period'; action: PromotionBenefitAction | null; value: number | null; enabled: boolean; durationMonths: number | null };

export interface AppliedPromotionForBilling extends PromotionApplicationWindow {
  membershipFeeBenefits: MembershipFeeBenefit[];
}

/**
 * Applies every currently-relevant promotion's Membership Fee benefit(s) to
 * `basePrice` at `atDate`, the same math `computeFinalPrice` uses for "now"
 * — evaluated instead at an arbitrary projected date. Returns whether any
 * benefit actually applied at that date (regardless of whether it net
 * changed the price), which is what "promotion affected" means throughout
 * this module.
 */
export function computeMembershipFeePriceAt(
  basePrice: number,
  atDate: string,
  promotions: AppliedPromotionForBilling[],
): { price: number; promotionAffected: boolean } {
  let price = basePrice;
  let affected = false;
  for (const promo of promotions) {
    if (!promotionCoversDate(promo, atDate)) continue;
    for (const b of promo.membershipFeeBenefits) {
      if (b.kind === 'charge') {
        price = applyPeriodBenefit(price, b.action, b.value);
        affected = true;
      } else if (b.enabled && b.action) {
        if (b.durationMonths != null && atDate >= addCalendarMonths(promo.appliedAt, b.durationMonths)) continue;
        price = applyPeriodBenefit(price, b.action, b.value);
        affected = true;
      }
    }
  }
  return { price, promotionAffected: affected };
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
  const { billingStart, endsAt, basePrice, recurringInterval, recurringUnit, promotions } = input;
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
    const { price, promotionAffected } = computeMembershipFeePriceAt(basePrice, cursor, promotions);
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
