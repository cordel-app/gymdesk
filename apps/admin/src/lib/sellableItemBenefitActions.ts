// #896 stage 4 — the pricing treatment a Sellable Item carries *inside* a
// Promotion or a Membership Plan, as the two editors offer it.
//
// Mirrored from `api/src/domain/sellableItemBenefitActions.ts`, which is what
// actually enforces any of this (a frontend-only list is not a rule) and what
// the CHECK beside each of the twelve tables backs up. This file exists for the
// same reason `plans/planProfile.ts` mirrors the Billing frequency pair: the
// page has to render the options and decide which of them asks for a second
// input, and it must not spell the list out inline. A new action therefore goes
// in the API module, its CHECK, *and* here —
// `sellable-item-benefit-actions-ui.test.ts` fails if this copy drifts.
//
// The **stored vocabulary is one**, deliberately: a Plan benefit and a
// Promotion grant stay comparable. Only the *labels* differ by context, and
// they are locale keys resolved by the owning page (§3: the Promotions UI says
// **Promotion** / *No promotion* and never the word "Benefit"; the Membership
// Plans UI says **Benefit** / *No benefit*), which is why no label lives here.

export type SellableItemBenefitAction =
  | 'no_benefit'
  | 'waive'
  | 'percentage_discount'
  | 'fixed_discount'
  | 'fixed_price';

/** Which of the two editors is configuring the item. */
export type SellableItemBenefitContext = 'promotion' | 'plan';

/** §2 — what a Promotion may configure, in dropdown order. */
export const PROMOTION_ITEM_ACTIONS: readonly SellableItemBenefitAction[] = [
  'no_benefit',
  'waive',
  'percentage_discount',
  'fixed_discount',
  'fixed_price',
];

/**
 * §5/§16 — what a Membership Plan may configure. A strict subset: "Membership
 * Plans cannot configure `Fixed discount` or `Fixed Price`".
 */
export const PLAN_BENEFIT_ACTIONS: readonly SellableItemBenefitAction[] = [
  'no_benefit',
  'waive',
  'percentage_discount',
];

/** §13's neutral default: the item is included at its normal price. */
export const DEFAULT_BENEFIT_ACTION: SellableItemBenefitAction = 'no_benefit';

export function benefitActionsFor(
  context: SellableItemBenefitContext,
): readonly SellableItemBenefitAction[] {
  return context === 'promotion' ? PROMOTION_ITEM_ACTIONS : PLAN_BENEFIT_ACTIONS;
}

/**
 * §6 — does the selected action need a second input? The same predicate the
 * API applies, so the dropdown cannot offer a shape the `PUT` then 400s.
 */
export function benefitActionRequiresValue(action: SellableItemBenefitAction): boolean {
  return action === 'percentage_discount'
    || action === 'fixed_discount'
    || action === 'fixed_price';
}

/** A percentage is bounded 0..100; the two monetary actions are not. */
export function isPercentageBenefitAction(action: SellableItemBenefitAction): boolean {
  return action === 'percentage_discount';
}

/**
 * The action a stored row reads as in a given context. A row carrying an action
 * its context may not configure (only reachable if the catalogue is edited
 * behind the screen's back) reads as the neutral default rather than leaking a
 * `fixed_price` into a Plan's three-option dropdown — exactly what
 * `toSellableItemBenefit()` does server-side.
 */
export function benefitActionOf(
  context: SellableItemBenefitContext, action: unknown,
): SellableItemBenefitAction {
  return typeof action === 'string'
    && (benefitActionsFor(context) as readonly string[]).includes(action)
    ? action as SellableItemBenefitAction
    : DEFAULT_BENEFIT_ACTION;
}
