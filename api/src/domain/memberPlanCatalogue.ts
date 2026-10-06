import { PromotionBenefitAction } from './promotionBenefits';
import { applyPeriodBenefit } from './promotionBenefits';

/**
 * #1122 §1–§6 — what the Members App may offer when a member **adds a
 * Membership Plan**, and what a compatible Promotion does to its price.
 *
 * Pure: the SQL that reads the catalogue and the Promotions lives in
 * `api/src/api/me-membership-plans.ts`, the two-module split #1121 and #1118
 * use. Three of its answers are the rule rather than the implementation.
 *
 *  - **A Promotion is offered only where its Membership Fee Benefit says
 *    something.** The benefit is the one row `promotion_membership_fee_benefits`
 *    holds (#635 §5); a disabled row, a `no_benefit` action or a percentage of
 *    zero changes nothing, and an *Apply promotion* button under a price that
 *    cannot move is the thing #1118 refused for Products. `waive` **is**
 *    offered here, unlike for a Product purchase: a Promotion that makes the
 *    first months free is a real Membership Plan offer, and a plan whose first
 *    cycle owes nothing is activated by Save & Pay with no payment to make
 *    (#1108 stage 2).
 *  - **The preview is the first cycle's price under that benefit alone.**
 *    `applyPeriodBenefit()` is the one place a `(action, value)` pair becomes an
 *    amount; the authoritative number is what the assignment reports once it
 *    exists (`membership_fee`, resolved by `resolveMembershipFee()` over the
 *    Plan's own Free Period and the Promotion's timeline), so the preview
 *    never claims more than "this is what the Promotion does to the price".
 *  - **The duration is calendar months**, the Promotion's own unit (#892 moved
 *    only Plan durations onto a billing frequency), reported as such and
 *    never relabelled as billing cycles.
 */

export const PLAN_PROMOTION_TARGET = 'membership_plan';

export interface MembershipFeeBenefitRow {
  enabled: boolean | number | null;
  action: PromotionBenefitAction | string | null;
  value: number | string | null;
  duration_months: number | string | null;
}

export function isOfferableFeeBenefit(benefit: MembershipFeeBenefitRow | null | undefined): boolean {
  if (!benefit || !benefit.enabled) return false;
  const value = benefit.value == null ? null : Number(benefit.value);
  switch (benefit.action) {
    case 'waive': return true;
    case 'percentage_discount': return value != null && value > 0 && value <= 100;
    case 'fixed_discount': return value != null && value > 0;
    case 'fixed_price': return value != null && value >= 0;
    default: return false;
  }
}

/** The first cycle's VAT-inclusive price under the benefit, never below zero. */
export function firstCycleFinalPrice(priceInclTax: number, benefit: MembershipFeeBenefitRow): number {
  const value = benefit.value == null ? null : Number(benefit.value);
  const result = applyPeriodBenefit(priceInclTax, benefit.action as PromotionBenefitAction, value);
  return Math.round(Math.max(0, result) * 100) / 100;
}
