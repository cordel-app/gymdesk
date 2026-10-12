import { describe, expect, it } from 'vitest';
import {
  discountedUnitPrice,
  oneTimeProductAlreadyOwned,
  parseDirectDiscountPercent,
  priceProductPurchase,
  type PricedPromotion,
} from '../domain/productPurchasePricing';

// #1521 stage 2 — Oscar's decisions 2 and 4: stackable Promotions, one
// percentage direct discount (VAT-inclusive, Admin only), never a free purchase.

const promo = (id: number, action: string, value: number | null, stackable = true): PricedPromotion => ({
  promotion_id: id, promotion_name: `P${id}`, action, value, duration_cycles: null, stackable,
});

describe('priceProductPurchase', () => {
  it('is the list price when nothing applies', () => {
    const r = priceProductPurchase({ listPrice: 100 });
    expect(r).toMatchObject({ ok: true, price: { list_price: 100, final_price: 100, direct_discount_amount: null } });
  });

  it('applies the direct discount to the VAT-inclusive price and reports both figures', () => {
    const r = priceProductPurchase({ listPrice: 121, promotions: [], directDiscountPercent: 10 });
    expect(r).toMatchObject({ ok: true, price: { direct_discount_percent: 10, direct_discount_amount: 12.1, final_price: 108.9 } });
  });

  it('applies promotions in order to the running price, then the direct discount last', () => {
    const r = priceProductPurchase({
      listPrice: 100,
      promotions: [promo(1, 'percentage_discount', 50), promo(2, 'fixed_discount', 10)],
      directDiscountPercent: 10,
    });
    if (!r.ok) throw new Error(r.refusal);
    expect(r.price.promotions.map((s) => [s.regular_amount, s.final_amount])).toEqual([[100, 50], [50, 40]]);
    expect(r.price.after_promotions).toBe(40);
    expect(r.price.direct_discount_amount).toBe(4);
    expect(r.price.final_price).toBe(36);
  });

  it('refuses two promotions unless every one is stackable', () => {
    const r = priceProductPurchase({
      listPrice: 100,
      promotions: [promo(1, 'percentage_discount', 10), promo(2, 'percentage_discount', 10, false)],
    });
    expect(r).toEqual({ ok: false, refusal: 'promotions_not_stackable' });
  });

  it('never refuses a single non-stackable promotion for stacking', () => {
    const r = priceProductPurchase({ listPrice: 100, promotions: [promo(1, 'percentage_discount', 10, false)] });
    expect(r.ok).toBe(true);
  });

  it('refuses the same promotion twice', () => {
    const r = priceProductPurchase({
      listPrice: 100, promotions: [promo(1, 'percentage_discount', 10), promo(1, 'percentage_discount', 10)],
    });
    expect(r).toEqual({ ok: false, refusal: 'duplicate_promotion' });
  });

  it('refuses a promotion that would not lower the running price or would make it free', () => {
    expect(priceProductPurchase({ listPrice: 100, promotions: [promo(1, 'waive', null)] }))
      .toEqual({ ok: false, refusal: 'promotion_not_lowering_price' });
    expect(priceProductPurchase({ listPrice: 100, promotions: [promo(1, 'fixed_price', 150)] }))
      .toEqual({ ok: false, refusal: 'promotion_not_lowering_price' });
  });

  it('refuses a discount that brings the price to zero or below, instead of clamping', () => {
    expect(priceProductPurchase({ listPrice: 0.01, directDiscountPercent: 60 }))
      .toEqual({ ok: false, refusal: 'final_price_not_positive' });
    expect(priceProductPurchase({ listPrice: 100, directDiscountPercent: 100 }))
      .toEqual({ ok: false, refusal: 'invalid_direct_discount' });
  });

  it('has no price to quote for an unpriced Product', () => {
    expect(priceProductPurchase({ listPrice: null })).toEqual({ ok: false, refusal: 'no_price' });
  });
});

describe('parseDirectDiscountPercent', () => {
  it('accepts nothing, or a percentage strictly between 0 and 100 with at most two decimals', () => {
    for (const none of [undefined, null, '', 0, '0']) expect(parseDirectDiscountPercent(none)).toEqual({ percent: null });
    expect(parseDirectDiscountPercent(12.5)).toEqual({ percent: 12.5 });
    expect(parseDirectDiscountPercent('15')).toEqual({ percent: 15 });
  });
  it('refuses anything else, never coercing it', () => {
    for (const bad of [-5, 100, 120, 'abc', 10.123, NaN]) {
      expect(parseDirectDiscountPercent(bad)).toEqual({ error: 'invalid_direct_discount' });
    }
  });
});

describe('discountedUnitPrice', () => {
  it('scales proportionally and leaves an undiscounted price alone', () => {
    expect(discountedUnitPrice(20, 25)).toBe(15);
    expect(discountedUnitPrice(19.99, null)).toBe(19.99);
  });
});

describe('oneTimeProductAlreadyOwned', () => {
  it('is true for an active or pending purchase and never for a cancelled one', () => {
    expect(oneTimeProductAlreadyOwned(['active'])).toBe(true);
    expect(oneTimeProductAlreadyOwned(['cancelled', 'pending_payment'])).toBe(true);
    expect(oneTimeProductAlreadyOwned(['cancelled'])).toBe(false);
    expect(oneTimeProductAlreadyOwned([])).toBe(false);
  });
});
