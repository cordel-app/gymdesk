// #1122 §1–§6 — everything the Members App's **Add Plan** decides or formats,
// and nothing it draws.
//
// The split is `memberProducts.ts`' (#1121/#1118): this module answers which
// locale **key** a line reads under and how a figure is written, the
// `MemberPlanCatalogue` component is the look, and the page resolves the keys
// — so nothing here calls `t()`, no money is computed here (the server quotes
// every price, the promotion's `final_price_incl_tax` included), and both
// halves stay assertable.

import { formatPaymentAmount } from './memberPayments';
import { promotionBenefitNote, type ProductNote } from './memberProducts';

/** One compatible Promotion, as `GET /me/membership-plans` reports it. */
export interface MemberPlanOfferPromotion {
  id: number;
  name: string;
  benefit: { action: string | null; value: number | null };
  /** The Membership Fee Benefit's own unit: calendar months (#635 §5). */
  duration_months: number | null;
  /** The first cycle's VAT-inclusive price under this Promotion — the server's figure. */
  final_price_incl_tax: number | null;
}

/** One Plan benefit line, as `GET /me/membership-plans` reports it. */
export interface MemberPlanOfferBenefit {
  section: 'session' | 'oneoff' | 'periodical';
  product_id: number;
  product_name: string;
  mandatory: boolean;
}

export function planBenefitKey(b: Pick<MemberPlanOfferBenefit, 'section' | 'product_id'>): string {
  return `${b.section}:${b.product_id}`;
}

/**
 * The request's `declined_benefits`: only unticked *optional* lines. The API's
 * `declinedBenefitsError()` is the enforcement; this never names a mandatory one.
 */
export function declinedBenefitsPayload(
  benefits: MemberPlanOfferBenefit[] | undefined, declinedKeys: ReadonlySet<string>,
): Array<{ section: string; product_id: number }> {
  return (benefits ?? [])
    .filter((b) => !b.mandatory && declinedKeys.has(planBenefitKey(b)))
    .map((b) => ({ section: b.section, product_id: b.product_id }));
}

/** One plan a member may choose, as `GET /me/membership-plans` reports it. */
export interface MemberPlanOffer {
  id: number;
  name: string;
  description: string | null;
  price_incl_tax: number | null;
  tax_included: boolean;
  billing_interval: number | null;
  billing_unit: string | null;
  promotions: MemberPlanOfferPromotion[];
  /** The Plan's benefit lines (#1184 stage 3b); absent from an older API. */
  benefits?: MemberPlanOfferBenefit[];
}

/** The member's plan awaiting its first payment, as `GET /me/membership` reports it. */
export interface MemberPendingPlan {
  id: number;
  plan_name: string | null;
  starts_at: string | null;
  membership_fee: number | null;
}

/**
 * Which `membership.frequency` key the plan's cadence reads under — the one
 * map the Products already use (#1128) — or `null` for a cadence that map has
 * no word for, which the page then spells as the pair.
 */
export function planFrequencyKey(plan: Pick<MemberPlanOffer, 'billing_interval' | 'billing_unit'>): string | null {
  const { billing_interval: interval, billing_unit: unit } = plan;
  if (interval === 1 && unit === 'month') return 'membership.frequency.month';
  if (interval === 4 && unit === 'week') return 'membership.frequency.four_weeks';
  if (interval === 1 && unit === 'year') return 'membership.frequency.year';
  return null;
}

/** The catalogue price, formatted; `null` for a plan with no price (reads `—`). */
export function planPriceText(plan: Pick<MemberPlanOffer, 'price_incl_tax'>, locale: string, currency = 'EUR'): string | null {
  return plan.price_incl_tax == null ? null : formatPaymentAmount(plan.price_incl_tax, currency, locale);
}

/**
 * The final price the card shows, given the Promotion the member applied in
 * the page (if any): the Promotion's own server-quoted figure replaces the
 * plan's price rather than being recomputed here.
 */
export function planFinalPrice(plan: MemberPlanOffer, appliedPromotionId: number | null): number | null {
  if (appliedPromotionId == null) return plan.price_incl_tax;
  const applied = plan.promotions.find((p) => p.id === appliedPromotionId);
  return applied?.final_price_incl_tax ?? plan.price_incl_tax;
}

export function planFinalPriceText(plan: MemberPlanOffer, appliedPromotionId: number | null, locale: string, currency = 'EUR'): string | null {
  const price = planFinalPrice(plan, appliedPromotionId);
  return price == null ? null : formatPaymentAmount(price, currency, locale);
}

/** *50% discount* — the same vocabulary and keys the Products use. */
export function planPromotionBenefitNote(promotion: MemberPlanOfferPromotion, locale: string, currency = 'EUR'): ProductNote | null {
  if (!promotion.benefit.action) return null;
  return promotionBenefitNote(promotion.benefit.action, promotion.benefit.value, currency, locale);
}

/** *3 months* — the Membership Fee Benefit's own unit, never relabelled as cycles. */
export function planPromotionDurationNote(promotion: MemberPlanOfferPromotion): ProductNote | null {
  if (promotion.duration_months == null || promotion.duration_months <= 0) return null;
  return { key: 'membership.promotion_duration_months', values: { count: promotion.duration_months } };
}

/** A first cycle that owes nothing is activated with no payment to make (#1108 stage 2). */
export function choosingOwesNothing(plan: MemberPlanOffer, appliedPromotionId: number | null): boolean {
  const price = planFinalPrice(plan, appliedPromotionId);
  return price == null || price <= 0;
}

/** The refusal a `POST /me/membership-plans/:id/assign` answers, as the member's own key. */
export function assignErrorKey(message: string | null | undefined): string {
  if (message === 'active_plan_exists') return 'membership.add_plan_replace_body';
  if (message === 'plan_pending_payment') return 'membership.add_plan_pending_error';
  return 'membership.add_plan_error';
}
