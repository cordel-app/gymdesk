import { describe, expect, it } from 'vitest';
import { computeGrossFromPreservedNet, computeVatPreview } from '../lib/priceVat';

// #547 — Membership Plans Pricing section live VAT recalculation.
// computeVatPreview mirrors the backend's computePriceFields()
// (api/src/api/sellable-items.ts) exactly, so unit-testing it here also
// pins the shared net/gross rounding contract between the two.

describe('computeVatPreview', () => {
  it('treats the amount as VAT-inclusive (gross) and derives net for "inclusive" behavior', () => {
    const { amount_excl_tax, amount_incl_tax } = computeVatPreview(121, 21, 'inclusive');
    expect(amount_incl_tax).toBe(121);
    expect(amount_excl_tax).toBe(100);
  });

  it('treats the amount as net and derives gross for "exclusive" behavior', () => {
    const { amount_excl_tax, amount_incl_tax } = computeVatPreview(100, 21, 'exclusive');
    expect(amount_excl_tax).toBe(100);
    expect(amount_incl_tax).toBe(121);
  });

  it('leaves the price unchanged for a 0% rate regardless of behavior', () => {
    expect(computeVatPreview(50, 0, 'inclusive')).toEqual({ amount_excl_tax: 50, amount_incl_tax: 50 });
    expect(computeVatPreview(50, 0, 'exclusive')).toEqual({ amount_excl_tax: 50, amount_incl_tax: 50 });
  });

  it('rounds to 2 decimals using the same convention as the backend (parseFloat(toFixed(2)))', () => {
    // 10 / 1.21 = 8.2644... -> 8.26
    const { amount_excl_tax } = computeVatPreview(10, 21, 'inclusive');
    expect(amount_excl_tax).toBe(8.26);
  });

  it('matches the backend computePriceFields() output for a range of rates and behaviors', () => {
    function computePriceFields(amount: number, rate: number, behavior: 'inclusive' | 'exclusive') {
      const factor = 1 + rate / 100;
      const amount_excl_tax = behavior === 'inclusive' ? parseFloat((amount / factor).toFixed(2)) : parseFloat(amount.toFixed(2));
      const amount_incl_tax = behavior === 'exclusive' ? parseFloat((amount * factor).toFixed(2)) : parseFloat(amount.toFixed(2));
      return { amount_excl_tax, amount_incl_tax };
    }

    for (const rate of [0, 4, 10, 21]) {
      for (const behavior of ['inclusive', 'exclusive'] as const) {
        for (const amount of [0, 9.99, 49.5, 199]) {
          expect(computeVatPreview(amount, rate, behavior)).toEqual(computePriceFields(amount, rate, behavior));
        }
      }
    }
  });
});

describe('computeGrossFromPreservedNet', () => {
  it('recomputes the gross price from a fixed net amount at the new rate', () => {
    expect(computeGrossFromPreservedNet(100, 21)).toBe(121);
    expect(computeGrossFromPreservedNet(100, 10)).toBe(110);
  });

  it('does not simply add the new rate to the old gross price (net stays the reference point)', () => {
    // Regression for req. 12: changing VAT from 10% to 21% on a net price of
    // 100 must land on 121 (100 * 1.21), not on some additive combination
    // of the old gross (110) and the new rate.
    const oldGross = computeGrossFromPreservedNet(100, 10); // 110
    const newGross = computeGrossFromPreservedNet(100, 21); // 121, net (100) preserved
    expect(oldGross).toBe(110);
    expect(newGross).toBe(121);
    expect(newGross).not.toBe(oldGross * 1.21);
  });

  it('leaves the gross price unchanged for a 0% rate', () => {
    expect(computeGrossFromPreservedNet(75, 0)).toBe(75);
  });

  it('rounds to 2 decimals', () => {
    expect(computeGrossFromPreservedNet(33.33, 21)).toBe(40.33); // 33.33 * 1.21 = 40.3293 -> 40.33
  });
});
