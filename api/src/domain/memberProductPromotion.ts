// #1118 — the **Promotion a member applies to a Product they are buying**: which
// Promotions are offered for a Product, what applying one does to its price,
// and the snapshot the purchase keeps of it.
//
// It is the third module of the #1121 family's split and it keeps that split
// exactly: `memberProductCatalogue.ts` answers *which Products a member may be
// shown*, `memberProductPurchase.ts` answers *what buying one means*, this one
// answers *what a Promotion does to one*, and `api/src/api/me-products.ts` plus
// `api/src/api/member-product-promotions.ts` are the I/O halves. Pure — no DB,
// no provider, no `t()` (CLAUDE.md).
//
// Five of its answers are the rule rather than the implementation.
//
//  - **A Promotion's own grant rows say which Products it is about.** The
//    thread's `Q4` is explicit — *"do not introduce a second
//    `promotion_products` relation [...] the Product selected inside the
//    Promotion is already the source of truth for applicability"* — so the
//    offer is the grant row the Promotion already carries for that Product, in
//    the section the Product classifies into (`classifyProduct()`, #550, never
//    a second mapping), and the `(action, value)` pair on it (#896) is the
//    benefit. No migration added a target relation, and none may.
//  - **A grant that changes no price is not an offer.** `no_benefit` is the
//    neutral default every grant row is written with unless somebody chose
//    otherwise (`DEFAULT_BENEFIT_ACTION`), so offering one would put an *Apply
//    promotion* button on the member's screen that recalculates nothing —
//    §5's whole point is that applying changes the Final price. It is the one
//    thing filtered out beyond the Promotion's own eligibility, and it is
//    filtered *here* rather than in the query so both halves can be asserted.
//  - **The price is the one every other surface quotes.** `applyLineBenefit()`
//    (#896) is the single place a pair becomes an amount — the very function
//    the Billing Simulation's charge builders and the Promotion card's own
//    *Final Price* call — applied to the VAT-inclusive figure
//    `computePriceFields()` produced, with an amount-taking action taken at face
//    value as gross (`product-benefit-pricing.ts`' note, unchanged here). So a
//    member and the gym owner reading the same Promotion cannot be quoted two
//    numbers, and this module performs no tax arithmetic of its own (#817).
//  - **Duration is the Periodic grant's own number, and a one-off has none.**
//    #1135 settled that `promotion_periodical.quantity` *is* a Duration — the
//    periods a grant covers — so that is what §6's "duration in billing cycles"
//    reads from. The thread's `Q5` is equally explicit that a one-off Product
//    has no cycles to express one in, so a `session` or `oneoff` grant answers
//    `null` and the surface says nothing rather than inventing *1 billing
//    cycle*. Under stage 2 every purchasable Product is non-recurring, so today
//    that is every offer; the rule is written for the recurring purchases a
//    later stage adds rather than against them.
//  - **The snapshot is what was applied, never a link to what it is now.**
//    §7/§13/§14 restate #635 §16 word for word, so the purchase keeps the
//    Promotion's name, its `(action, value)` pair, its duration and both
//    amounts, and `promotion_id` stays beside them as the link to the live row —
//    the same "snapshot beside a link" `member_products` itself is built on.
//    Nothing reads the live Promotion to describe an application again.

import { type ProductBenefitCategory, classifyProduct } from './productClassification';
import {
  type ProductBenefit,
  DEFAULT_BENEFIT_ACTION,
  applyLineBenefit,
  toProductBenefit,
} from './productBenefitActions';
import { type PromotionBenefitAction } from './promotionBenefits';

/** The `promotions.applies_to` value a member-facing offer must carry (#926). */
export const PRODUCT_PROMOTION_TARGET = 'product';

/** The grant table each category's offers are read from (#550's one mapping). */
export function promotionGrantTableFor(category: ProductBenefitCategory): string {
  switch (category) {
    case 'session': return 'promotion_session';
    case 'oneoff': return 'promotion_oneoff';
    case 'periodical': return 'promotion_periodical';
  }
}

/** Which section a Product's offers live in — `classifyProduct()` and nothing else. */
export function offerCategoryFor(product: { type: string; billing_frequency: string | null }): ProductBenefitCategory {
  return classifyProduct(product);
}

/**
 * Whether a grant's treatment is worth offering the member.
 *
 * `no_benefit` is the default a grant row carries when nobody configured a
 * treatment, and applying it would leave the Final price exactly where it was.
 * Everything else — `waive`, a percentage, a fixed discount, a fixed price —
 * changes what the member pays and is an offer.
 *
 * It is asked of the **normalized** pair rather than of the raw column, so a
 * `percentage_discount` whose value went missing (which `toProductBenefit()`
 * reads back as the neutral default, because an unusable pair must never
 * invent a discount) is not offered either.
 */
export function isOfferableBenefit(action: unknown, value: unknown): boolean {
  return toProductBenefit('promotion', action, value).action !== DEFAULT_BENEFIT_ACTION;
}

/**
 * How many billing cycles a grant covers, as §6 asks it to be expressed.
 *
 * A **periodical** grant's `quantity` is a Duration (#1135), so it is the
 * number of cycles. A session or one-off grant's `quantity` is a count of
 * units and says nothing about cycles, which is the thread's `Q5`: a one-off
 * Product has no billing periods, so there is no duration to quote and the
 * surface shows none.
 */
export function promotionDurationCycles(
  category: ProductBenefitCategory, quantity: unknown,
): number | null {
  if (category !== 'periodical') return null;
  const n = Number(quantity);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

/** One Promotion as the member is offered it, for one Product. */
export interface MemberProductPromotionOffer {
  promotion_id: number;
  promotion_name: string;
  product_id: number;
  /** The grant's own treatment, normalized in the Promotion's own option set. */
  action: PromotionBenefitAction;
  value: number | null;
  /** §6 — the cycles the Promotion covers, or `null` where it names none. */
  duration_cycles: number | null;
  /** The Product's own VAT-inclusive price, unchanged. */
  regular_price_incl_tax: number | null;
  /** That price with this Promotion applied — what the member would be charged. */
  final_price_incl_tax: number | null;
}

/** The columns an offer is read from, as mysql2 hands them back. */
export interface PromotionOfferRow {
  promotion_id: number | string;
  promotion_name: string;
  product_id: number | string;
  action?: unknown;
  value?: unknown;
  quantity?: unknown;
  only_applicable_for_new_members?: number | boolean | null;
}

/**
 * One grant row as an offer, priced against the Product's own gross price.
 *
 * `regular_price_incl_tax` is the caller's — the one figure
 * `computePriceFields()` produced for the catalogue — and the final price is
 * `applyLineBenefit()` at quantity 1, because a purchase buys the Product once
 * (a Sessions package's `units` is the size of the package, never a quantity to
 * multiply by, #942).
 */
export function shapePromotionOffer(
  row: PromotionOfferRow,
  category: ProductBenefitCategory,
  regularPriceInclTax: number | null,
): MemberProductPromotionOffer {
  const benefit = toProductBenefit('promotion', row.action, row.value);
  return {
    promotion_id: Number(row.promotion_id),
    promotion_name: row.promotion_name,
    product_id: Number(row.product_id),
    action: benefit.action,
    value: benefit.value,
    duration_cycles: promotionDurationCycles(category, row.quantity),
    regular_price_incl_tax: regularPriceInclTax,
    final_price_incl_tax: promotionalPrice(regularPriceInclTax, benefit),
  };
}

/**
 * What the member pays for one Product under a benefit — or `null` for a
 * Product carrying no price at all, which is not €0.00 and reads as `—`.
 */
export function promotionalPrice(
  regularPriceInclTax: number | null | undefined,
  benefit: ProductBenefit,
): number | null {
  if (regularPriceInclTax == null || !Number.isFinite(regularPriceInclTax)) return null;
  return applyLineBenefit(regularPriceInclTax, 1, benefit);
}

/** What a `member_product_promotions` row is written with, beside its ids. */
export interface PromotionApplicationSnapshot {
  promotion_name: string;
  benefit_action: PromotionBenefitAction;
  benefit_value: number | null;
  duration_cycles: number | null;
  regular_amount: number;
  final_amount: number;
}

/**
 * The snapshot an applied Promotion is frozen as.
 *
 * Both amounts are kept, not just the discount: §7 asks for "relevant
 * price/discount information needed to reproduce the applied pricing" and §13's
 * Admin view quotes *Price* beside *Final price*, so a reader must not have to
 * re-derive either from a catalogue that has since moved. They are the two
 * figures the member saw at the moment they applied it.
 */
export function promotionApplicationSnapshot(
  offer: MemberProductPromotionOffer,
): PromotionApplicationSnapshot | null {
  if (offer.regular_price_incl_tax == null || offer.final_price_incl_tax == null) return null;
  return {
    promotion_name: offer.promotion_name,
    benefit_action: offer.action,
    benefit_value: offer.value,
    duration_cycles: offer.duration_cycles,
    regular_amount: offer.regular_price_incl_tax,
    final_amount: offer.final_price_incl_tax,
  };
}

/** An applied Promotion as every surface reads it back (§13, §15). */
export interface AppliedPromotion extends PromotionApplicationSnapshot {
  id: number;
  promotion_id: number;
  applied_at: string | null;
}

/** One stored application, shaped for the wire. */
export function shapeAppliedPromotion(row: {
  id: number | string;
  promotion_id: number | string;
  promotion_name: string;
  benefit_action: string;
  benefit_value?: number | string | null;
  duration_cycles?: number | string | null;
  regular_amount: number | string;
  final_amount: number | string;
  applied_at?: string | null;
}): AppliedPromotion {
  const benefit = toProductBenefit('promotion', row.benefit_action, row.benefit_value);
  const duration = row.duration_cycles == null ? null : Number(row.duration_cycles);
  return {
    id: Number(row.id),
    promotion_id: Number(row.promotion_id),
    promotion_name: row.promotion_name,
    // Read in the Promotion's own option set, never a Plan's: a `fixed_price`
    // application read as a Plan row would normalize to the neutral default and
    // the Admin would quote the full price for a line the member was promised
    // at another one (#924 stage 2's rule, one table over).
    benefit_action: benefit.action,
    benefit_value: benefit.value,
    duration_cycles: duration != null && Number.isFinite(duration) ? duration : null,
    regular_amount: Number(row.regular_amount),
    final_amount: Number(row.final_amount),
    applied_at: row.applied_at ?? null,
  };
}

/** Why a Promotion the member named may not be applied to this purchase. */
export type PromotionRefusal = 'promotion_not_applicable';
