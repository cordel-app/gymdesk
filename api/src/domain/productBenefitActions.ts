// #896 stage 1 — the **pricing treatment** a Product carries inside a
// Promotion or a Membership Plan, and the vocabulary that decides it.
//
// Until this ticket, a Product configured in a Promotion section
// (`promotion_{session,oneoff,periodical}`, migration 155) or in a Membership
// Plan section (`membership_plan_{session,oneoff,periodical}`, migration 173)
// carried a `quantity` and nothing else. §15 adds the pair — a type and, when
// the type asks for one, a value — to the *relationship*, never to the global
// Product (§12): the same item may be waived by one Plan and discounted
// 20% by a Promotion, and `products` learns nothing from either.
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
//      CHECK — `product-benefit-actions.unit.test.ts` fails if they part.
//
// #997 narrowed the Plan set to **two**: `No benefit` and `Waive`. A Plan
// benefit says what the membership includes, and a percentage off one line of
// it was a third price beside the Product's own and the Promotion's. That
// narrowing is a *configuration* change and not a data change, so this module
// now draws two sets per context rather than one — what may be configured
// (`benefitActionsFor`) and what may be stored and read
// (`storedBenefitActionsFor`) — because a Plan that already carries a
// percentage must keep billing it until somebody corrects it. §8 leaves
// Promotions alone: they still configure all five.
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
export type ProductBenefitContext = 'promotion' | 'plan';

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
 * a fixed price on it would be a second price list beside the Product's
 * own. Widening this is a product decision, and it moves the CHECK with it.
 *
 * #997 narrowed it again, to two: a Plan benefit is now either charged at the
 * Product's normal price or waived outright. See `LEGACY_PLAN_BENEFIT_ACTIONS`
 * below for what that did *not* do to the rows that already store a
 * percentage.
 */
export type PlanBenefitAction = Extract<
  PromotionBenefitAction, 'no_benefit' | 'waive'
>;

export const PLAN_BENEFIT_ACTIONS: readonly PlanBenefitAction[] = [
  'no_benefit',
  'waive',
];

/**
 * #997 — retired from the *Membership Plan* surface, and retired is not
 * deleted. This is the same split `domain/productFrequency.ts` draws for a
 * Product's Billing Frequency, for the same reason and with the same two
 * halves:
 *
 *   OFFERED (`PLAN_BENEFIT_ACTIONS`) — what a Plan benefit may be
 *            *configured* with. The section `PUT`s accept only these.
 *   LEGACY  — stored, read, priced (`applyLineBenefit()`), displayed and
 *            snapshotted onto an assignment exactly as before, but never
 *            selectable again. A write may carry one through **unchanged**, so
 *            that editing a legacy line's quantity neither 400s nor quietly
 *            rewrites what the gym agreed to charge.
 *
 * No migration and no backfill: migration 203's `chk_<table>_action` keeps
 * permitting all three on the Plan side, because the rows holding a percentage
 * must stay valid, and the route — not the CHECK — is what refuses a new one.
 * §6 is explicit that an existing `% Discount` must not be silently converted
 * to `Waive` (that would make a €20 item free) nor silently read as
 * `No benefit` (that would start charging €20 for a line agreed at €16), so it
 * is neither: it keeps pricing as stored and is surfaced for correction —
 * `npm run plans:percentage-benefits` is the read-only report that finds every
 * one, and the editor renders the value as a disabled option beside it.
 *
 * A **Promotion** is untouched (§8): it still configures all five actions, and
 * `percentage_discount` is retired only in the `plan` context.
 */
export const LEGACY_PLAN_BENEFIT_ACTIONS: readonly PromotionBenefitAction[] = [
  'percentage_discount',
];

/**
 * Everything a Plan-side row may hold — what migration 203's CHECK permits and
 * what a read answers with. Offered first, so the order still matches the
 * migration's own list.
 */
export const STORED_PLAN_BENEFIT_ACTIONS: readonly PromotionBenefitAction[] = [
  ...PLAN_BENEFIT_ACTIONS,
  ...LEGACY_PLAN_BENEFIT_ACTIONS,
];

/**
 * §13's neutral default: the item is included at its normal Product
 * price. It is what a row written before this ticket reads as, what a new row
 * starts at, and what the column defaults to in SQL.
 *
 * It is **not** what existing *Promotion* rows were backfilled to — those
 * meant "free" before the column existed, so migration 203 writes `waive` onto
 * them. See that migration's header.
 */
export const DEFAULT_BENEFIT_ACTION: PromotionBenefitAction = 'no_benefit';

/** The actions one context may **configure** — the dropdown, and the `PUT`. */
export function benefitActionsFor(
  context: ProductBenefitContext,
): readonly PromotionBenefitAction[] {
  return context === 'promotion' ? PROMOTION_ITEM_ACTIONS : PLAN_BENEFIT_ACTIONS;
}

/**
 * The actions one context may **store** — what a read answers with. Identical
 * to the offered set for a Promotion; wider on the Plan side, by exactly the
 * values #997 retired (see `LEGACY_PLAN_BENEFIT_ACTIONS`).
 *
 * The two sets are deliberately different functions: a reader that asked
 * `benefitActionsFor()` would normalize a stored percentage to the neutral
 * default and start charging the full price for a line the gym agreed at a
 * discount, which is §6's "must not silently produce incorrect prices".
 */
export function storedBenefitActionsFor(
  context: ProductBenefitContext,
): readonly PromotionBenefitAction[] {
  return context === 'promotion' ? PROMOTION_ITEM_ACTIONS : STORED_PLAN_BENEFIT_ACTIONS;
}

/** May this context configure this action? (The write gate.) */
export function isBenefitActionAllowed(
  context: ProductBenefitContext, action: unknown,
): action is PromotionBenefitAction {
  return typeof action === 'string'
    && (benefitActionsFor(context) as readonly string[]).includes(action);
}

/** May this context's column hold this action? (The read gate.) */
export function isStoredBenefitAction(
  context: ProductBenefitContext, action: unknown,
): action is PromotionBenefitAction {
  return typeof action === 'string'
    && (storedBenefitActionsFor(context) as readonly string[]).includes(action);
}

/**
 * #997 — is this a treatment this context *stores* but no longer *offers*? True
 * only for `percentage_discount` on the Plan side; a Promotion retires nothing.
 *
 * One predicate serves the write rule below and the editor's disabled option,
 * so neither can decide for itself what counts as legacy.
 */
export function isRetiredBenefitAction(
  context: ProductBenefitContext, action: unknown,
): boolean {
  return isStoredBenefitAction(context, action)
    && !isBenefitActionAllowed(context, action);
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
 * `current` is what the row stores today (`undefined`/`null` when the line is
 * new), and it exists for #997's one rule: a **retired** action passes only
 * when it is exactly the pair the row already holds — same action, same value.
 * That is how a legacy `% Discount` line stays editable while a new one can
 * never be created and an existing one can never be re-negotiated on a surface
 * that no longer offers percentages. `domain/productFrequency.ts`'s
 * `productFrequencyWriteError(next, current)` is the same rule one entity over.
 *
 * Returns the message, or `null` when the pair is valid.
 */
export function benefitConfigError(
  context: ProductBenefitContext,
  action: unknown,
  value: unknown,
  current?: ProductBenefit | null,
): string | null {
  const allowed = benefitActionsFor(context);
  if (!isStoredBenefitAction(context, action)) {
    return `action must be one of: ${allowed.join(', ')}`;
  }
  if (!isBenefitActionAllowed(context, action)
    && !keepsRetiredBenefit(context, action, value, current)) {
    return `action '${action}' is no longer offered on a Membership Plan benefit `
      + 'and can only be kept unchanged on a line that already stores it; '
      + `choose one of: ${allowed.join(', ')}`;
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

/**
 * #997 — does this submitted pair simply carry back the retired treatment the
 * row already stores? Both halves have to match: a legacy line may be *kept*,
 * never re-configured, so moving 20% to 50% is refused exactly as creating a
 * new percentage line is. The comparison is numeric, because the stored value
 * arrives as mysql2's `DECIMAL` string on one side and a form number on the
 * other.
 */
export function keepsRetiredBenefit(
  context: ProductBenefitContext,
  action: unknown,
  value: unknown,
  current?: ProductBenefit | null,
): boolean {
  if (!isRetiredBenefitAction(context, action)) return false;
  if (!current || current.action !== action) return false;
  if (!benefitActionRequiresValue(current.action)) return value == null || value === '';
  const next = Number(value);
  return Number.isFinite(next) && Number(current.value) === next;
}

/** One relationship row's pricing treatment, normalized. */
export interface ProductBenefit {
  action: PromotionBenefitAction;
  /** The percentage or the amount. Always null for `no_benefit` and `waive`. */
  value: number | null;
}

export const NO_PRODUCT_BENEFIT: ProductBenefit = {
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
export function toProductBenefit(
  context: ProductBenefitContext, action: unknown, value: unknown,
): ProductBenefit {
  // #997: the **stored** set, not the offered one — a legacy `percentage_discount`
  // on a Plan row keeps pricing and displaying as the gym configured it.
  if (!isStoredBenefitAction(context, action)) return NO_PRODUCT_BENEFIT;
  if (!benefitActionRequiresValue(action)) return { action, value: null };
  const n = Number(value);
  if (value == null || value === '' || !Number.isFinite(n) || n < 0) return NO_PRODUCT_BENEFIT;
  if (action === 'percentage_discount') return { action, value: Math.min(100, n) };
  return { action, value: Math.min(MAX_BENEFIT_AMOUNT, n) };
}

/**
 * What one configured line costs, given the Product's own unit price.
 *
 * The **line**, not the unit, is the basis — the thread's answer to Q2: "if
 * %discount is applied […] it will be applied to the total of Price x
 * Quantity", and "Fixed amount or Fixed discount apply per line". So a €10
 * item at quantity 10 with a €15 fixed discount bills €85, not €0, and with a
 * Fixed Price of €20 it bills €20 for the line.
 *
 * The arithmetic itself is `applyPeriodBenefit()` — this function decides only
 * what amount to hand it. Since stage 3 the Billing Simulation's two charge
 * builders are what call it (`domain/billingSimulation.ts`): a Plan benefit's
 * own pair prices the line for the life of the assignment, and a covering
 * Promotion grant's pair is folded on top for the periods or units that grant
 * covers.
 */
export function applyLineBenefit(
  unitPrice: number, quantity: number, benefit: ProductBenefit | null | undefined,
): number {
  const units = Number.isFinite(quantity) ? Math.max(0, quantity) : 0;
  const line = (Number.isFinite(unitPrice) ? unitPrice : 0) * units;
  if (!benefit || benefit.action === 'no_benefit') return Math.round(line * 100) / 100;
  return applyPeriodBenefit(line, benefit.action, benefit.value);
}

/* ── Stage 2: what a request may say, and what a read reports ────────────── */

/**
 * The outcome of reading one submitted line's pricing treatment.
 *
 * `benefit: null` is **not** `no_benefit` — it is "this request did not
 * mention the pair at all", which is a different thing and the reason this is
 * three states rather than two. The six replace-all `PUT`s delete and re-insert
 * the whole section on every save, so a client that only knows about
 * `product_id` and `quantity` (every client until stage 4) would otherwise
 * rewrite a configured treatment to the neutral default on an unrelated edit —
 * and on the Promotion side that default is not what the row means, since
 * migration 203 backfilled those rows to `waive`. A line the request did not
 * mention therefore keeps what it is stored with, exactly as
 * `writeAssignedPlanBenefitSection()` keeps a kept line's frozen price.
 *
 * Clearing a treatment stays possible and stays explicit: send
 * `action: 'no_benefit'`.
 */
export interface ParsedProductBenefit {
  /** The 400's message, or `null` when the line is valid. */
  error: string | null;
  /** The pair to write, or `null` when the request named none. */
  benefit: ProductBenefit | null;
}

/**
 * §6's validation on the way in, for one line of a replace-all `PUT`.
 *
 * A `value` without an `action` is refused rather than ignored: it is the one
 * shape that reads as a configured discount the server would silently drop.
 */
export function parseProductBenefitInput(
  context: ProductBenefitContext,
  item: { action?: unknown; value?: unknown } | null | undefined,
  current?: ProductBenefit | null,
): ParsedProductBenefit {
  const action = item?.action;
  const value = item?.value;
  const hasValue = value !== undefined && value !== null && value !== '';
  if (action === undefined || action === null || action === '') {
    return { error: hasValue ? 'value requires an action' : null, benefit: null };
  }
  // #997: `current` is the pair this line is stored with, so a retired
  // treatment carried back unchanged is accepted and anything else on that
  // action is a 400. A line with no stored pair (a new line) can never pass.
  const error = benefitConfigError(context, action, value, current);
  if (error) return { error, benefit: null };
  const act = action as PromotionBenefitAction;
  return {
    error: null,
    benefit: { action: act, value: benefitActionRequiresValue(act) ? Number(value) : null },
  };
}

/**
 * One stored row as a read must report it: the pair normalized through
 * `toProductBenefit()`, so `value` is a number rather than the
 * `DECIMAL(10,2)` string mysql2 hands back, and a pair the context may not
 * configure reads as the neutral default rather than leaking out of its editor.
 */
export function shapeProductBenefitRow<T extends { action?: unknown; value?: unknown }>(
  context: ProductBenefitContext, row: T,
): Omit<T, 'action' | 'value'> & ProductBenefit {
  const benefit = toProductBenefit(context, row.action, row.value);
  return { ...row, action: benefit.action, value: benefit.value };
}
