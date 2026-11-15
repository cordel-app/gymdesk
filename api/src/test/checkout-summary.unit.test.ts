// #2860 — the Product Set Summary's two sections, as pure decisions.
import { describe, expect, it } from 'vitest';
import { contractedItems, initialPaymentBreakdown, type ChargeLineLike } from '../domain/checkoutSummary';

const line = (o: Partial<ChargeLineLike>): ChargeLineLike => ({
  item_name: 'Item', quantity: 1, amount: 0, regular_unit_price: null, promotion_name: null,
  treatment_action: null, treatment_value: null, tax_rate_percent: null, amount_excl_tax: null, ...o,
});

describe('initialPaymentBreakdown', () => {
  it('splits each charged line into unit price, discount and tax, and totals by rate', () => {
    const out = initialPaymentBreakdown([
      line({ item_name: 'Monthly fee', amount: 48.4, regular_unit_price: 60.5, promotion_name: 'Spring', tax_rate_percent: 21, amount_excl_tax: 40 }),
      line({ item_name: 'Towel', quantity: 2, amount: 10, regular_unit_price: 5, tax_rate_percent: 21, amount_excl_tax: 8.26 }),
      line({ item_name: 'Book', amount: 11.04, regular_unit_price: 11.04, tax_rate_percent: 4, amount_excl_tax: 10.62 }),
    ], 69.44);
    expect(out.lines[0]).toEqual(expect.objectContaining({ unit_price: 60.5, discount: 12.1, promotion_name: 'Spring', tax_amount: 8.4, amount: 48.4 }));
    expect(out.lines[1]).toEqual(expect.objectContaining({ unit_price: 5, discount: 0, tax_amount: 1.74 }));
    expect(out.discount_total).toBe(12.1);
    expect(out.taxes).toEqual([
      { rate_percent: 4, base: 10.62, tax: 0.42 },
      { rate_percent: 21, base: 48.26, tax: 10.14 },
    ]);
    expect(out.tax_total).toBe(10.56);
    expect(out.subtotal_excl_tax).toBe(58.88);
    expect(out.total).toBe(69.44);
    expect(Math.round((out.subtotal_excl_tax + out.tax_total) * 100) / 100).toBe(out.total);
  });

  it('a line with no rate carries no tax and no tax row; a line with no regular price no discount', () => {
    const out = initialPaymentBreakdown([line({ quantity: 4, amount: 20 })], 20);
    expect(out.lines[0]).toEqual(expect.objectContaining({ unit_price: 5, discount: 0, tax_amount: 0, tax_rate_percent: null }));
    expect(out.taxes).toEqual([]);
    expect(out.subtotal_excl_tax).toBe(20);
  });

  it('reports the charge it was handed, null included, never a re-added figure', () => {
    expect(initialPaymentBreakdown([], null).total).toBeNull();
    expect(initialPaymentBreakdown([], 0).total).toBe(0);
  });
});

describe('contractedItems', () => {
  const names = new Map<number, string | null>([[1, 'Ana'], [2, 'Bru']]);

  it('lists plans, recurring lines and one-time Products with their members and no amount', () => {
    const items = contractedItems({
      plans: [
        {
          plan_name: 'Duo', billing_interval: 1, billing_unit: 'month', entitlement_only: false,
          beneficiaries: [{ member_id: 1, name: 'Ana' }, { member_id: 2, name: 'Bru' }],
          benefits: [{ name: 'Locker', quantity: 1, billing_frequency: 'month', assigned_member_id: 2, member_name: 'Bru' }],
        },
        { plan_name: 'Ending', billing_interval: 1, billing_unit: 'month', entitlement_only: true, beneficiaries: [], benefits: [] },
      ],
      lines: [{ product_name: 'Towel', quantity: 2, billing_frequency: 'month', assigned_member_id: 1 }],
      purchases: [{ product_name: 'Water', units: null, billing_frequency: 'once', assigned_member_id: null, member_id: 2 }],
    }, names);
    expect(items.map((i) => [i.kind, i.name, i.period])).toEqual([
      ['plan', 'Duo', 'recurring'], ['product', 'Towel', 'recurring'], ['product', 'Water', 'one_off'],
    ]);
    expect(items[0].cadence).toEqual({ interval: 1, unit: 'month' });
    expect(items[0].members.map((m) => m.name)).toEqual(['Ana', 'Bru']);
    expect(items[0].included[0].members).toEqual([{ member_id: 2, name: 'Bru' }]);
    expect(items[1].members).toEqual([{ member_id: 1, name: 'Ana' }]);
    expect(items[2].members).toEqual([{ member_id: 2, name: 'Bru' }]);
    expect(JSON.stringify(items)).not.toMatch(/price|amount|discount|tax/);
  });

  it('a recurring line with a one-time frequency reads as one-off', () => {
    const [item] = contractedItems({ plans: [], lines: [{ product_name: 'Pass', quantity: 1, billing_frequency: 'once', assigned_member_id: null }], purchases: [] }, names);
    expect(item.period).toBe('one_off');
    expect(item.members).toEqual([]);
  });
});
