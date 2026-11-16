import { describe, expect, it } from 'vitest';
import { initialLineTaxRate, withLineTax, type InitialChargeTaxRates } from '../domain/initialChargeTaxes';
import type { BillingEventLineRow } from '../domain/billingEventLines';

const rates: InitialChargeTaxRates = {
  system: 21,
  byFeeKey: new Map([[1, 10], [2, null]]),
  byProduct: new Map([[7, 4], [8, 0], [9, null]]),
};

const row = (amount: number): BillingEventLineRow => ({
  kind: 'product', product_id: 7, item_name: 'X', item_type: null, quantity: 1, regular_unit_price: amount,
  treatment_action: 'no_benefit', treatment_value: null, promotion_name: null, prorated_days: null, period_days: null,
  tax_rate_percent: null, tax_behavior: null, amount_excl_tax: null, amount,
});

describe('initialLineTaxRate (#2947)', () => {
  it("takes a fee's plan rate, else the gym's", () => {
    expect(initialLineTaxRate({ kind: 'membership_fee', product_id: null, user_membership_id: 1 }, rates)).toBe(10);
    expect(initialLineTaxRate({ kind: 'membership_fee', product_id: null, user_membership_id: 2 }, rates)).toBe(21);
  });
  it("takes a Product's own rate, keeps an exempt 0%, and falls back to the gym's", () => {
    expect(initialLineTaxRate({ kind: 'product', product_id: 7 }, rates)).toBe(4);
    expect(initialLineTaxRate({ kind: 'product', product_id: 8 }, rates)).toBe(0);
    expect(initialLineTaxRate({ kind: 'product', product_id: 9 }, rates)).toBe(21);
  });
  it('prefers the rate frozen on a purchase', () => {
    expect(initialLineTaxRate({ kind: 'product', product_id: 7, frozen_rate: 10 }, rates)).toBe(10);
  });
});

describe('withLineTax (#2947)', () => {
  it('splits the final (discounted) amount, never the regular price', () => {
    const l = withLineTax({ ...row(52), regular_unit_price: 104 }, 4);
    expect(l.amount_excl_tax).toBe(50);
    expect(l.amount).toBe(52);
  });
  it('a waived line carries no tax, and no rate leaves the line as it was', () => {
    expect(withLineTax(row(0), 21).amount_excl_tax).toBe(0);
    expect(withLineTax(row(10), null)).toEqual(row(10));
  });
});
