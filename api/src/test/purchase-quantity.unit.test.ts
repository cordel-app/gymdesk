// #3020 stage 5 — the quantity of a one-time purchase: what is accepted and how the total is made.
import { describe, expect, it } from 'vitest';
import { MAX_PURCHASE_QUANTITY, parsePurchaseQuantity, purchaseSnapshot, purchaseTotal } from '../domain/memberProductPurchase';

describe('parsePurchaseQuantity', () => {
  it('defaults to 1 when the request names none', () => {
    expect(parsePurchaseQuantity(undefined)).toBe(1);
    expect(parsePurchaseQuantity(null)).toBe(1);
    expect(parsePurchaseQuantity('')).toBe(1);
  });
  it('accepts a whole number from 1 to the maximum', () => {
    expect(parsePurchaseQuantity(3)).toBe(3);
    expect(parsePurchaseQuantity('2')).toBe(2);
    expect(parsePurchaseQuantity(MAX_PURCHASE_QUANTITY)).toBe(MAX_PURCHASE_QUANTITY);
  });
  it('refuses anything else instead of coercing it', () => {
    for (const bad of [0, -1, 1.5, MAX_PURCHASE_QUANTITY + 1, 'x', NaN]) expect(parsePurchaseQuantity(bad)).toBeNull();
  });
});

describe('purchase total', () => {
  it('multiplies the final unit price, cents-exact', () => {
    expect(purchaseTotal(0.1, 3)).toBe(0.3);
    expect(purchaseTotal(33.33, 3)).toBe(99.99);
  });
  it('a snapshot charges the unit price (after Promotions and the discount) times the quantity; a Sessions package price is unchanged', () => {
    const s = purchaseSnapshot({
      name: 'Pack 5', type: 'sessions', billing_frequency: 'once', units: 5,
      price_incl_tax: 36, currency: 'EUR', tax_rate_percent: 21, quantity: 2,
    });
    expect(s.unit_amount).toBe(36);
    expect(s.quantity).toBe(2);
    expect(s.amount).toBe(72);
    expect(s.units).toBe(5);
  });
  it('defaults to one unit', () => {
    expect(purchaseSnapshot({
      name: 'x', type: 'fee', billing_frequency: 'once', units: null, price_incl_tax: 10, currency: 'EUR', tax_rate_percent: null,
    }).amount).toBe(10);
  });
});
