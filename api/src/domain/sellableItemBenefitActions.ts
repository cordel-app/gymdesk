// #896 stage 1 — the **pricing treatment** a Sellable Item carries inside a
// Promotion or a Membership Plan, and the vocabulary that decides it.
//
// Until this ticket, a Sellable Item configured in a Promotion section
// (`promotion_{session,oneoff,periodical}`, migration 155) or in a Membership
// Plan section (`membership_plan_{session,oneoff,periodical}`, migration 173)
// carried a `quantity` and nothing else. §15 adds the pair — a type and, when
// the type asks for one, a value — to the *relationship*, never to the global
// Sellable Item (§12): the same item may be waived by one Plan and discounted
// 20% by a Promotion, and `gym_charges` learns nothing from either.
//
// Two rules make this module the only place that decides any of it:
//
//   1. **The vocabulary is not a new one.** `PromotionBenefitAction`
//      (`domain/promotionBenefits.ts`) already declares exactly the five
//      values §2 lists, and `applyPeriodBenefit()` is already the one place an
//      (action, value) pair becomes an amount — which is what §11's "do not
//      introduce a second independent pricing system" asks for. This module
//      adds the two *option sets* and the value rules, not a second enum and
//      not a second arithmetic.
//   2. **The option set is per context.** A Promotion offers all five; a
//      Membership Plan offers three, because §16 states outright that "Membership
//      Plans cannot configure `Fixed discount` or `Fixed Price`". The CHECK
//      beside each table (migration 203) is what enforces that rather than the
//      dropdown, so a new action goes in **two** places: the list here and the
//      CHECK — `sellable-item-benefit-actions.unit.test.ts` fails if they part.
//
// The UI *labels* differ by context and deliberately do not live here: the
// Promotions screen says **Promotion** / *No promotion* and the Membership
// Plans screen says **Benefit** / *No benefit* (§3, §4) for the same stored
// `no_benefit`. Labels are locale keys (stage 4); the stored value is one
// vocabulary, so a Plan benefit and a Promotion grant remain comparable.
//
// Pure — no DB, no HTTP (CLAUDE.md).

import { PromotionBenefitAction, applyPeriodBenefit } from './promotionBenefits';

/** Which of the two editors is configuring the item. */
export type SellableItemBenefitContext = 'promotion' | 'plan';

/** §2 — what a Promotion may configure, in dropdown order. */
export const PROMOTION_ITEM_ACTIONS: readonly PromotionBenefitAction[] = [
  'no_benefit',
  'waive',
  'percentage_discount',
  'fixed_discount',
  'fixed_price',
];

/**
 * §5/§16 — what a Membership Plan may configure. A strict subset: a Plan
 * benefit describes what the membership *includes*, so a monetary discount or
 * a fixed price on it would be a second price list beside the Sellable Item's
 * own. Widening this is a product decision, and it moves the CHECK with it.
 */
export type PlanBenefitAction = Extract<
  PromotionBenefitAction, 'no_benefit' | 'waive' | 'percentage_discount'
>;

export const PLAN_BENEFIT_ACTIONS: readonly PlanBenefitAction[] = [
  'no_benefit',
  'waive',
  'percentage_discount',
];

/**
 * §13's neutral default: the item is included at its normal Sellable Item
 * price. It is what a row written before this ticket reads as, what a new row
 * starts at, and what the column defaults to in SQL.
 *
 * It is **not** what existing *Promotion* rows were backfilled to — those
 * meant "free" before the column existed, so migration 203 writes `waive` onto
 * them. See that migration's header.
 */
export const DEFAULT_BENEFIT_ACTION: PromotionBenefitAction = 'no_benefit';

/** The actions one context may store. */
export function benefitActionsFor(
  context: SellableItemBenefitContext,
): readonly PromotionBenefitAction[] {
  return context === 'promotion' ? PROMOTION_ITEM_ACTIONS : PLAN_BENEFIT_ACTIONS;
}

export function isBenefitActionAllowed(
  context: SellableItemBenefitContext, action: unknown,
): action is PromotionBenefitAction {
  return typeof action === 'string'
    && (benefitActionsFor(context) as readonly string[]).includes(action);
}

/**
 * §6 — does the selected action need a second input?
 *
 * `no_benefit` and `waive` are complete on their own; the other three are not.
 * One predicate serves the frontend (whether to render the input) and the
 * backend (whether to demand it), so the two cannot disagree.
 */
export function benefitActionRequiresValue(action: PromotionBenefitAction): boolean {
  return action === 'percentage_discount'
    || action === 'fixed_discount'
    || action === 'fixed_price';
}

/** The largest amount `DECIMAL(10,2)` holds — a value above it is a 400, not a truncation. */
export const MAX_BENEFIT_AMOUNT = 99_999_999.99;

/**
 * §6's validation, both halves of it: a value-requiring action with no usable
 * value is refused, and so is a value on an action that takes none — the
 * editor keeps a previously typed number while you switch options (§16
 * "existing configured values are preserved appropriately while editing"), so
 * it must submit only the value belonging to the selected option, and the
 * server is what makes that true.
 *
 * Returns the message, or `null` when the pair is valid.
 */
export function benefitConfigError(
  context: SellableItemBenefitContext,
  action: unknown,
  value: unknown,
): string | null {
  const allowed = benefitActionsFor(context);
  if (!isBenefitActionAllowed(context, action)) {
    return `action must be one of: ${allowed.join(', ')}`;
  }
  const hasValue = value !== undefined && value !== null && value !== '';
  if (!benefitActionRequiresValue(action)) {
    return hasValue ? `${action} takes no value` : null;
  }
  if (!hasValue) return `${action} requires a value`;
  const n = Number(value);
  if (!Number.isFinite(n)) return `${action} requires a numeric value`;
  if (action === 'percentage_discount') {
    return n >= 0 && n <= 100 ? null : 'percentage_discount value must be between 0 and 100';
  }
  if (n < 0) return `${action} value must not be negative`;
  return n <= MAX_BENEFIT_AMOUNT ? null : `${action} value must not exceed ${MAX_BENEFIT_AMOUNT}`;
}

/** One relationship row's pricing treatment, normalized. */
export interface SellableItemBenefit {
  action: PromotionBenefitAction;
  /** The percentage or the amount. Always null for `no_benefit` and `waive`. */
  value: number | null;
}

export const NO_SELLABLE_ITEM_BENEFIT: SellableItemBenefit = {
  action: DEFAULT_BENEFIT_ACTION, value: null,
};

/**
 * A stored `(action, value)` pair as a reader needs it — defensive in the same
 * way `toPersonalFeeBenefit()` is, because a read must price to something sane
 * even for a row written before the column existed (`action` NULL for the
 * instant between migration 203's two statements) or one whose value went
 * missing. An unusable pair reads as the neutral default, which charges the
 * normal price and can never invent a discount.
 *
 * `context` is what keeps a Plan section from reading a `fixed_price` it may
 * not configure, whatever is in the column.
 */
export function toSellableItemBenefit(
  context: SellableItemBenefitContext, action: unknown, value: unknown,
): SellableItemBenefit {
  if (!isBenefitActionAllowed(context, action)) return NO_SELLABLE_ITEM_BENEFIT;
  if (!benefitActionRequiresValue(action)) return { action, value: null };
  const n = Number(value);
  if (value == null || value === '' || !Number.isFinite(n) || n < 0) return NO_SELLABLE_ITEM_BENEFIT;
  if (action === 'percentage_discount') return { action, value: Math.min(100, n) };
  return { action, value: Math.min(MAX_BENEFIT_AMOUNT, n) };
}

/**
 * What one configured line costs, given the Sellable Item's own unit price.
 *
 * The **line**, not the unit, is the basis — the thread's answer to Q2: "if
 * %discount is applied […] it will be applied to the total of Price x
 * Quantity", and "Fixed amount or Fixed discount apply per line". So a €10
 * item at quantity 10 with a €15 fixed discount bills €85, not €0, and with a
 * Fixed Price of €20 it bills €20 for the line.
 *
 * The arithmetic itself is `applyPeriodBenefit()` — this function decides only
 * what amount to hand it. Nothing calls it yet: the billing cutover is stage 3
 * of the plan agreed on #896, and this is where the answered semantics live
 * until it does.
 */
export function applyLineBenefit(
  unitPrice: number, quantity: number, benefit: SellableItemBenefit | null | undefined,
): number {
  const units = Number.isFinite(quantity) ? Math.max(0, quantity) : 0;
  const line = (Number.isFinite(unitPrice) ? unitPrice : 0) * units;
  if (!benefit || benefit.action === 'no_benefit') return Math.round(line * 100) / 100;
  return applyPeriodBenefit(line, benefit.action, benefit.value);
}
