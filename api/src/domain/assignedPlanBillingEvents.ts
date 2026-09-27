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
//   - Query the actual persisted `billing_events` rows within that
//     calculated range. #511 also projected a non-persisted view for a
//     `draft` plan, which had no ledger yet; #786 retired that status, and
//     the projection went with it.
//   - Ordered chronologically, scoped to this plan, no duplicates, no
//     fabricated placeholders, fewer events if the plan ends early.
//
// No DB access here — this module only turns already-fetched, already
// date-normalized (YYYY-MM-DD) inputs into a range + event list, so it's
// unit-testable without `createTestGym`/`db` (see CLAUDE.md's unit-vs-
// integration test guidance). `api/src/api/user-memberships.ts` does the
// DB reads/writes and date normalization around it.

import { advanceBillingDate } from './billingDate';
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

// How many calendar months of billing events to show after the last one
// affected by a promotion (or after the billing start date, if none apply).
// Fixed by the issue thread's Q2 answer — not configurable per gym/plan.
const MONTHS_AFTER_LAST_PROMOTION = 2;

/** Adds `months` calendar months to a YYYY-MM-DD date string. */
export function addCalendarMonths(dateStr: string, months: number): string {
  return advanceBillingDate(dateStr, months, 'month');
}

function clampToEndsAt(dateStr: string, endsAt: string | null): string {
  return endsAt != null && endsAt < dateStr ? endsAt : dateStr;
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

export interface BillingEventsView<E> {
  available: boolean;
  reason: string | null;
  projected: boolean;
  range_start: string | null;
  range_end: string | null;
  events: E[];
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
 * Nothing here is projected — this only ever tags and filters
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
