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
      line({ item_name: 'Towel', quantity: 2, amount: 10, regular_unit_price: 10, tax_rate_percent: 21, amount_excl_tax: 8.26 }),
      line({ item_name: 'Book', amount: 11.04, regular_unit_price: 11.04, tax_rate_percent: 4, amount_excl_tax: 10.62 }),
    ], 69.44);
    expect(out.lines[0]).toEqual(expect.objectContaining({ unit_price: 60.5, discount: 12.1, promotion_name: 'Spring', tax_amount: 8.4, amount: 48.4 }));
    expect(out.lines[1]).toEqual(expect.objectContaining({ unit_price: 5, line_total: 10, discount: 0, tax_amount: 1.74 }));
    expect(out.total_before_discounts).toBe(81.54);
    expect(Math.round((out.total_before_discounts - out.discount_total) * 100) / 100).toBe(out.total);
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

  // #2890 — the stored regular price is the whole line's (the engine's
  // `regular_price = unit × quantity`): a 10-unit €50 line waived read as a
  // €500 unit price and a −€5,000 discount.
  it('reads the regular price as the line total: unit price is per unit and the discount is the line total minus the charge', () => {
    const out = initialPaymentBreakdown([
      line({ item_name: 'PT session', quantity: 10, amount: 0, regular_unit_price: 500, treatment_action: 'waive' }),
      line({ item_name: 'Locker', quantity: 3, amount: 27, regular_unit_price: 30, treatment_action: 'percentage_discount', treatment_value: 10 }),
    ], 27);
    expect(out.lines[0]).toEqual(expect.objectContaining({ quantity: 10, unit_price: 50, line_total: 500, discount: 500, amount: 0 }));
    expect(out.lines[1]).toEqual(expect.objectContaining({ quantity: 3, unit_price: 10, line_total: 30, discount: 3, amount: 27 }));
    expect(out.total_before_discounts).toBe(530);
    expect(out.discount_total).toBe(503);
    expect(Math.round((out.total_before_discounts - out.discount_total) * 100) / 100).toBe(out.total);
    for (const l of out.lines) expect(Math.round((l.line_total - l.discount) * 100) / 100).toBe(l.amount);
  });

  it('a line with no rate carries no tax and no tax row; a line with no regular price no discount', () => {
    const out = initialPaymentBreakdown([line({ quantity: 4, amount: 20 })], 20);
    expect(out.lines[0]).toEqual(expect.objectContaining({ unit_price: 5, line_total: 20, discount: 0, tax_amount: 0, tax_rate_percent: null }));
    expect(out.taxes).toEqual([]);
    expect(out.subtotal_excl_tax).toBe(20);
  });

  // #2883 — the Membership Fee line that collects a Pre-paid Duration carries the periods it covers
  // and their cadence beside its quantity (the number of fees), from the same resolved line.
  it('carries a prepaid fee line\'s periods and cadence, and nothing on any other line', () => {
    const out = initialPaymentBreakdown([
      line({ item_name: 'Family', quantity: 1, amount: 140, prepaid_periods: 2, prepaid_cadence: { interval: 1, unit: 'month' } }),
      line({ item_name: 'Towel', quantity: 2, amount: 10 }),
    ], 150);
    expect(out.lines[0]).toEqual(expect.objectContaining({
      quantity: 1, amount: 140, prepaid_periods: 2, prepaid_cadence: { interval: 1, unit: 'month' },
    }));
    expect(out.lines[1]).toEqual(expect.objectContaining({ prepaid_periods: null, prepaid_cadence: null }));
  });

  // #3360 — proration is the stretch the charge covers, never a discount: a 7-of-30-days line of
  // two €30 lockers, 50% Promotion and 10% direct discount, is €14.00 before discounts, −€7.70, €6.30.
  it('measures a prorated line against its prorated regular price, so only real discounts are deducted', () => {
    const out = initialPaymentBreakdown([
      line({ item_name: 'Locker', quantity: 2, amount: 6.3, regular_unit_price: 60, prorated_days: 7, period_days: 30, treatment_action: 'percentage_discount', treatment_value: 50 }),
      line({ item_name: 'Towel', quantity: 3, amount: 9, regular_unit_price: 9, prorated_days: 30, period_days: 30 }),
    ], 15.3);
    expect(out.lines[0]).toEqual(expect.objectContaining({ quantity: 2, unit_price: 30, line_total: 14, discount: 7.7, amount: 6.3 }));
    expect(out.lines[0].proration).toEqual({ days: 7, period_days: 30 });
    expect(out.lines[1]).toEqual(expect.objectContaining({ unit_price: 3, line_total: 9, discount: 0, amount: 9 }));
    expect(out.total_before_discounts).toBe(23);
    expect(out.discount_total).toBe(7.7);
    expect(Math.round((out.total_before_discounts - out.discount_total) * 100) / 100).toBe(out.total);
  });

  it('a prorated line with no discount deducts nothing', () => {
    const out = initialPaymentBreakdown([
      line({ quantity: 2, amount: 12, regular_unit_price: 60, prorated_days: 6, period_days: 30 }),
    ], 12);
    expect(out.lines[0]).toEqual(expect.objectContaining({ unit_price: 30, line_total: 12, discount: 0, amount: 12 }));
    expect(out.discount_total).toBe(0);
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

describe('contractedItems — pending deletion (#3007 stage 4)', () => {
  it('marks a plan and a recurring line the Draft ends, with their effective end date, and leaves the rest alone', () => {
    const names = new Map<number, string | null>();
    const items = contractedItems({
      plans: [
        { plan_name: 'Gold', billing_interval: 1, billing_unit: 'month', entitlement_only: false, beneficiaries: [], benefits: [], pending_deletion: true, ends_at: '2026-12-31' },
        { plan_name: 'Silver', billing_interval: 1, billing_unit: 'month', entitlement_only: false, beneficiaries: [], benefits: [] },
      ],
      lines: [
        { product_name: 'Locker', quantity: 1, billing_frequency: 'month', assigned_member_id: null, pending_deletion: true, ends_at: '2026-12-31' },
        { product_name: 'Towel', quantity: 1, billing_frequency: 'month', assigned_member_id: null },
      ],
      purchases: [],
    }, names);
    expect(items.map((i) => i.pending_deletion)).toEqual([
      { ends_on: '2026-12-31' }, null, { ends_on: '2026-12-31' }, null,
    ]);
  });
});
