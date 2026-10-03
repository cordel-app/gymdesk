/**
 * #926: what a Promotion **applies to** — a Membership Plan, or a Product
 * bought on its own.
 *
 * `promotions.applies_to` (migration 204) is configuration and nothing else in
 * this ticket: no apply, pricing or snapshot path reads it. What it decides is
 * which configuration the Promotion editor shows, because the two
 * Plan-specific sections — the **Membership Fee** Benefit
 * (`promotion_membership_fee_benefits`, migration 179) and **Suitable
 * Membership Plans** (`promotion_membership_plans`) — are meaningless for a
 * Promotion that is not about a Plan.
 *
 * Switching the target **reinterprets nothing** (§4): the rows of both those
 * tables stay exactly as stored, so switching back shows the configuration that
 * was there before. That is also why the frontend stops *writing* Suitable
 * Membership Plans while the target is `sellable_item` rather than writing an
 * empty list — a replace-all `PUT` of `[]` would silently discard it.
 *
 * A new target goes in **two** places: `PROMOTION_TARGETS` below and the
 * `chk_promotions_applies_to` CHECK (current definition: migration 204).
 * Adding only the first makes every write of that target fail at the database.
 * It is mirrored for the browser in
 * `apps/admin/src/lib/promotionTargets.ts` — the radio group's option list —
 * and `promotion-target.unit.test.ts` asserts the two agree.
 */

export const PROMOTION_TARGETS = ['membership_plan', 'sellable_item'] as const;

export type PromotionTarget = (typeof PROMOTION_TARGETS)[number];

/**
 * What a Promotion created without a target is: the behaviour every Promotion
 * had before this ticket, and the column's own DEFAULT. A caller that omits
 * `applies_to` therefore configures a Membership Plan Promotion, which is what
 * keeps an API client that predates the column working unchanged.
 */
export const DEFAULT_PROMOTION_TARGET: PromotionTarget = 'membership_plan';

export function isPromotionTarget(value: unknown): value is PromotionTarget {
  return typeof value === 'string' && (PROMOTION_TARGETS as readonly string[]).includes(value);
}

/** The accepted set, for a 400's message. */
export function describePromotionTargets(): string {
  return PROMOTION_TARGETS.join(', ');
}

/**
 * True while the Promotion's Membership-Plan-specific configuration applies.
 * One predicate so a surface asking "may this Promotion carry a Membership Fee
 * Benefit / Suitable Membership Plans?" cannot answer it two ways.
 */
export function targetsMembershipPlan(appliesTo: unknown): boolean {
  return (isPromotionTarget(appliesTo) ? appliesTo : DEFAULT_PROMOTION_TARGET) === 'membership_plan';
}
