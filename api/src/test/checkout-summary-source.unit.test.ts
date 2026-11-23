// #3270 — the Summary's Initial Payment keeps each line's persisted `source` (#3254) as it is: per
// line in a mixed charge, and `null` for a line no source applies to (never guessed).
import { describe, expect, it } from 'vitest';
import { chargeLineView, initialPaymentBreakdown } from '../domain/checkoutSummary';

const line = (item_name: string, amount: number, source: unknown) => ({
  item_name, quantity: 1, amount, regular_unit_price: amount, promotion_name: null, treatment_action: null,
  treatment_value: null, tax_rate_percent: 21, amount_excl_tax: Math.round((amount / 1.21) * 100) / 100, source,
});

describe('Initial Payment line source (#3270)', () => {
  it('keeps each line its own source in a mixed charge, and null where none applies', () => {
    const lines = [line('Membership Fee', 40, 'plan'), line('Locker', 15, 'product'), line('Adjustment', 5, null)].map(chargeLineView);
    const p = initialPaymentBreakdown(lines, 60);
    expect(p.lines.map((l) => l.source)).toEqual(['plan', 'product', null]);
    expect(p.total).toBe(60);
  });

  it('reads an unknown or missing value as no source rather than inventing one', () => {
    expect(chargeLineView(line('X', 1, 'service')).source).toBeNull();
    expect(chargeLineView({ ...line('X', 1, 'plan'), source: undefined }).source).toBeNull();
  });
});
