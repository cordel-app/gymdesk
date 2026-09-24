// #635 stage 12 — one **application** of a Promotion to an assignment, as every
// pricing path needs it.
//
// These types used to live in `assignedPlanBillingEvents.ts`, which meant the
// only module that could see them *and* the Promotion timeline was
// `billingSimulation.ts` (it imports the former). So the Billing Events
// projection grew its own rule for when a Promotion's Membership Fee Benefit
// applies — "for as long as the application stands, gated by its own
// `duration_months`" — while the Billing Simulation used the Promotion's
// Free/Paid/Bonus timeline. For the same cycle of the same assignment the two
// answered different numbers (#635 stage 12's table).
//
// Moving them here inverts that dependency: `billingSimulation.ts` (which owns
// `resolveMembershipFee`, *the* rule) imports this module instead, so
// `assignedPlanBillingEvents.ts` can import the rule from it without a cycle.
// Both old modules re-export what they used to declare, so existing importers
// are unaffected.

import { PromotionBenefitAction } from './promotionBenefits';

/**
 * The [applied, revoked] window during which an application affected billing.
 * `revokedAt: null` means still applied (or never revoked) — the window is
 * open-ended. Dates are plain YYYY-MM-DD strings (time-of-day is irrelevant
 * to which billing cycle/event a promotion did or didn't cover).
 */
export interface PromotionApplicationWindow {
  appliedAt: string;
  revokedAt: string | null;
}

/** Is `atDate` inside the window during which this application affected billing? */
export function promotionCoversDate(w: PromotionApplicationWindow, atDate: string): boolean {
  return w.appliedAt <= atDate && (w.revokedAt == null || w.revokedAt >= atDate);
}

/**
 * A single Membership Fee Benefit contributed by an applied Promotion, as the
 * application's own snapshot recorded it (#635 §16).
 *
 * #635 stage 5 collapsed this from a two-variant union. A Promotion used to
 * carry the same benefit as either a Charge Benefit (no expiry) or a Period
 * Benefit (duration-gated); both tables are gone and the one that remains is
 * duration-gated, with a legacy Charge Benefit reading back as an enabled
 * benefit whose duration is null.
 *
 * #635 stage 12: a null `durationMonths` is **not** "forever" — the benefit
 * belongs to the Promotion, so it is capped at the Promotion's own
 * Free/Paid/Bonus timeline (`effectiveBenefitDurationMonths`, #625). See
 * `resolveMembershipFee`.
 */
export type MembershipFeeBenefit = {
  action: PromotionBenefitAction | null;
  value: number | null;
  enabled: boolean;
  durationMonths: number | null;
};

/**
 * One applied Promotion, with everything that decides what it does to the
 * Membership Fee on a given date: its window, its own Free/Paid/Bonus timeline
 * and its Membership Fee Benefit(s).
 *
 * The Free/Paid/Bonus months moved here in stage 12 — they are no longer a
 * Billing-Simulation-only concern, because they are what *ends* the Membership
 * Fee Benefit for every caller (the thread's stage 12 answer (a): "a Promotion's
 * own Free/Paid/Bonus months determine when its Membership Fee Benefit ends").
 */
export interface AppliedPromotionForBilling extends PromotionApplicationWindow {
  /** The Promotion's name, for the benefit line that explains a charge. */
  name?: string | null;
  freeMonths: number;
  paidMonths: number;
  /** Reclassifies some Paid months as prepaid; never lengthens the Promotion. */
  payBeforehandMonths: number;
  bonusMonths: number;
  membershipFeeBenefits: MembershipFeeBenefit[];
}
