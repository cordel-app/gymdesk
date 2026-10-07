// #896 stage 4 — the pricing treatment a Product carries *inside* a
// Promotion or a Membership Plan, as the two editors offer it.
//
// Mirrored from `api/src/domain/productBenefitActions.ts`, which is what
// actually enforces any of this (a frontend-only list is not a rule) and what
// the CHECK beside each of the twelve tables backs up. This file exists for the
// same reason `plans/planProfile.ts` mirrors the Billing frequency pair: the
// page has to render the options and decide which of them asks for a second
// input, and it must not spell the list out inline. A new action therefore goes
// in the API module, its CHECK, *and* here —
// `product-benefit-actions-ui.test.ts` fails if this copy drifts.
//
// The **stored vocabulary is one**, deliberately: a Plan benefit and a
// Promotion grant stay comparable. Only the *labels* differ by context, and
// they are locale keys resolved by the owning page (§3: the Promotions UI says
// **Promotion** / *No promotion* and never the word "Benefit"; the Membership
// Plans UI says **Benefit** / *No benefit*), which is why no label lives here.

export type ProductBenefitAction =
  | 'no_benefit'
  | 'waive'
  | 'percentage_discount'
  | 'fixed_discount'
  | 'fixed_price';

/** Which of the two editors is configuring the item. */
export type ProductBenefitContext = 'promotion' | 'plan';

/** §2 — what a Promotion may configure, in dropdown order. */
export const PROMOTION_ITEM_ACTIONS: readonly ProductBenefitAction[] = [
  'no_benefit',
  'waive',
  'percentage_discount',
  'fixed_discount',
  'fixed_price',
];

/**
 * §5/§16 — what a Membership Plan may configure. A strict subset: "Membership
 * Plans cannot configure `Fixed discount` or `Fixed Price`", and since #997 not
 * `% Discount` either — a Plan benefit is charged at the Product's normal price
 * or waived outright. #1184 stage 1 reversed #997's retirement of `% Discount`, so it
 * is offered again; `Fixed discount` and `Fixed Price` stay Promotion-only.
 */
export const PLAN_BENEFIT_ACTIONS: readonly ProductBenefitAction[] = [
  'no_benefit',
  'waive',
  'percentage_discount',
];

/**
 * #997 — stored on Plan-side rows written before the ticket, never selectable
 * again. The API module is what decides this (`LEGACY_PLAN_BENEFIT_ACTIONS`
 * there); this copy exists so the editor can render the stored value as a
 * **disabled** option rather than quietly reading it as `No benefit`, which
 * would quote the full price for a line the gym agreed at a discount.
 *
 * A Promotion retires nothing (§8), so this is empty in that context.
 */
export const LEGACY_PLAN_BENEFIT_ACTIONS: readonly ProductBenefitAction[] = [];

/** Everything a Plan-side row may hold — what a read answers with. */
export const STORED_PLAN_BENEFIT_ACTIONS: readonly ProductBenefitAction[] = [
  ...PLAN_BENEFIT_ACTIONS,
  ...LEGACY_PLAN_BENEFIT_ACTIONS,
];

/** §13's neutral default: the item is included at its normal price. */
export const DEFAULT_BENEFIT_ACTION: ProductBenefitAction = 'no_benefit';

/** What the dropdown offers. */
export function benefitActionsFor(
  context: ProductBenefitContext,
): readonly ProductBenefitAction[] {
  return context === 'promotion' ? PROMOTION_ITEM_ACTIONS : PLAN_BENEFIT_ACTIONS;
}

/** What a stored row may read as — wider than the above by #997's retired set. */
export function storedBenefitActionsFor(
  context: ProductBenefitContext,
): readonly ProductBenefitAction[] {
  return context === 'promotion' ? PROMOTION_ITEM_ACTIONS : STORED_PLAN_BENEFIT_ACTIONS;
}

/**
 * #997 — a treatment this context stores but no longer offers. The editor
 * renders it as a disabled option while the row holds it, and
 * `toBenefitItems()` still submits it unchanged, which is what the API accepts
 * as *keeping* it.
 */
export function isRetiredBenefitAction(
  context: ProductBenefitContext, action: unknown,
): boolean {
  return typeof action === 'string'
    && (storedBenefitActionsFor(context) as readonly string[]).includes(action)
    && !(benefitActionsFor(context) as readonly string[]).includes(action);
}

/**
 * §6 — does the selected action need a second input? The same predicate the
 * API applies, so the dropdown cannot offer a shape the `PUT` then 400s.
 */
export function benefitActionRequiresValue(action: ProductBenefitAction): boolean {
  return action === 'percentage_discount'
    || action === 'fixed_discount'
    || action === 'fixed_price';
}

/** A percentage is bounded 0..100; the two monetary actions are not. */
export function isPercentageBenefitAction(action: ProductBenefitAction): boolean {
  return action === 'percentage_discount';
}

/**
 * The action a stored row reads as in a given context. A row carrying an action
 * its context cannot even *store* (only reachable if the catalogue is edited
 * behind the screen's back) reads as the neutral default rather than leaking a
 * `fixed_price` into a Plan's dropdown — exactly what `toProductBenefit()` does
 * server-side, and off the same **stored** set, so #997's retired
 * `percentage_discount` still reads as itself on the line that holds it.
 */
export function benefitActionOf(
  context: ProductBenefitContext, action: unknown,
): ProductBenefitAction {
  return typeof action === 'string'
    && (storedBenefitActionsFor(context) as readonly string[]).includes(action)
    ? action as ProductBenefitAction
    : DEFAULT_BENEFIT_ACTION;
}
