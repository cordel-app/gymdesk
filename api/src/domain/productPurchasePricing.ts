// #1521 stage 2 — what a Product purchase costs when it carries several
// Promotions and, for an Admin, one direct discount. Pure: no DB, no provider.
//
// Three of its answers are the rule rather than the implementation.
//
//  - **The order is fixed and stated**: list price (VAT-inclusive) → each
//    Promotion in the order it was applied, every one pricing the *running*
//    figure with the existing `promotionalPrice()` (so `applyLineBenefit()` is
//    still the one place a pair becomes an amount) → the direct discount, a
//    percentage of that result. The ticket asks the discount to apply "to the
//    final price including VAT"; applying it last is that sentence.
//  - **Stacking is the Promotion's own flag.** Two or more are accepted only
//    when every one is `stackable` (the flag Membership Plan Promotions already
//    carry); a single Promotion is never refused for it.
//  - **A purchase never reaches zero.** This flow buys by paying, and there is
//    no free-grant path (#1118), so a discount that would bring the final price
//    to €0.00 or below is refused rather than clamped.
//
// A direct discount is **not** a Promotion and is never reported as one: it has
// its own percentage and amount on the result and on the stored snapshot.

import { toProductBenefit } from './productBenefitActions';
import { promotionalPrice } from './memberProductPromotion';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** One Promotion as the pricing needs it. */
export interface PricedPromotion {
  promotion_id: number;
  promotion_name: string;
  action: string;
  value: number | null;
  duration_cycles: number | null;
  stackable: boolean;
}

export interface PromotionPriceStep {
  promotion_id: number;
  promotion_name: string;
  action: string;
  value: number | null;
  duration_cycles: number | null;
  /** The running price this Promotion was applied to. */
  regular_amount: number;
  /** The running price after it. */
  final_amount: number;
}

export interface PurchasePrice {
  list_price: number;
  promotions: PromotionPriceStep[];
  after_promotions: number;
  direct_discount_percent: number | null;
  direct_discount_amount: number | null;
  final_price: number;
}

export type PricingRefusal =
  | 'invalid_direct_discount'
  | 'promotions_not_stackable'
  | 'duplicate_promotion'
  | 'promotion_not_lowering_price'
  | 'final_price_not_positive'
  | 'no_price';

export type PricingResult = { ok: true; price: PurchasePrice } | { ok: false; refusal: PricingRefusal };

/** The status and body a refused stack answers with. */
export function pricingRefusalResponse(
  refusal: PricingRefusal,
): { status: number; error: string; message: string } {
  switch (refusal) {
    case 'invalid_direct_discount':
      return { status: 400, error: refusal, message: 'The direct discount must be a percentage above 0 and below 100' };
    case 'final_price_not_positive':
      return { status: 400, error: refusal, message: 'The discount would bring the final price to zero or below' };
    case 'promotions_not_stackable':
      return { status: 409, error: refusal, message: 'These promotions cannot be combined' };
    case 'duplicate_promotion':
      return { status: 400, error: refusal, message: 'A promotion can only be applied once' };
    case 'promotion_not_lowering_price':
      return { status: 409, error: 'promotion_not_applicable', message: 'This promotion no longer lowers the price' };
    case 'no_price':
      return { status: 400, error: refusal, message: 'This product has no price to charge' };
  }
}

/**
 * Parses a request's direct discount: absent/`null`/`0` is none, a number
 * strictly between 0 and 100 (at most two decimals) is a percentage, anything
 * else is refused rather than coerced.
 */
export function parseDirectDiscountPercent(raw: unknown): { percent: number | null } | { error: PricingRefusal } {
  if (raw == null || raw === '' || raw === 0 || raw === '0') return { percent: null };
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n >= 100) return { error: 'invalid_direct_discount' };
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-9) return { error: 'invalid_direct_discount' };
  return { percent: n };
}

export function priceProductPurchase(input: {
  listPrice: number | null;
  promotions?: readonly PricedPromotion[];
  directDiscountPercent?: number | null;
}): PricingResult {
  const list = input.listPrice;
  const promotions = input.promotions ?? [];
  if (list == null || !Number.isFinite(list) || !(list > 0)) return { ok: false, refusal: 'no_price' };

  const ids = promotions.map((p) => p.promotion_id);
  if (new Set(ids).size !== ids.length) return { ok: false, refusal: 'duplicate_promotion' };
  if (promotions.length > 1 && !promotions.every((p) => p.stackable)) {
    return { ok: false, refusal: 'promotions_not_stackable' };
  }

  let running = round2(list);
  const steps: PromotionPriceStep[] = [];
  for (const promo of promotions) {
    const benefit = toProductBenefit('promotion', promo.action, promo.value);
    const next = promotionalPrice(running, benefit);
    // An offer is only ever one that prices the Product lower and above
    // nothing (the loader's rule); applied in sequence it must still hold.
    if (next == null || !(next > 0) || !(next < running)) {
      return { ok: false, refusal: 'promotion_not_lowering_price' };
    }
    steps.push({
      promotion_id: promo.promotion_id,
      promotion_name: promo.promotion_name,
      action: benefit.action,
      value: benefit.value,
      duration_cycles: promo.duration_cycles,
      regular_amount: running,
      final_amount: next,
    });
    running = next;
  }

  const pct = input.directDiscountPercent ?? null;
  let discountAmount: number | null = null;
  let final = running;
  if (pct != null) {
    if (!(pct > 0 && pct < 100)) return { ok: false, refusal: 'invalid_direct_discount' };
    discountAmount = round2(running * pct / 100);
    final = round2(running - discountAmount);
    if (!(final > 0) || !(discountAmount > 0)) return { ok: false, refusal: 'final_price_not_positive' };
  }

  return {
    ok: true,
    price: {
      list_price: round2(list),
      promotions: steps,
      after_promotions: running,
      direct_discount_percent: pct,
      direct_discount_amount: discountAmount,
      final_price: final,
    },
  };
}

/**
 * The unit price a recurring Product line is frozen at when a direct discount
 * was agreed: a percentage is proportional, so it holds whichever way the
 * Product's tax behaviour stores its amount.
 */
/**
 * The VAT contained in a VAT-inclusive amount (#1656). The server's, so the
 * Admin's breakdown does no tax arithmetic of its own; `null` where the Product
 * has no tax rate configured.
 */
export function vatPortion(grossAmount: number, ratePercent: number | null | undefined): number | null {
  if (ratePercent == null || !Number.isFinite(ratePercent) || ratePercent < 0) return null;
  return round2(grossAmount - grossAmount / (1 + ratePercent / 100));
}

export function discountedUnitPrice(unitPrice: number, percent: number | null): number {
  if (percent == null) return round2(unitPrice);
  return round2(unitPrice * (1 - percent / 100));
}

/** Whether a one-time Product may be bought again: not when it is held, pending or a staff draft (#1657). */
export function oneTimeProductAlreadyOwned(statuses: ReadonlyArray<string | null | undefined>): boolean {
  return statuses.some((s) => s === 'active' || s === 'pending_payment' || s === 'draft');
}
