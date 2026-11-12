// #2624 stage 3 — which engine charge an Assigned Plan line's Final Price is
// read from, and how a Promotion-covered charge becomes the row's figures.
// The flow against real MySQL is `assigned-plan-promotion-final-price.test.ts`.

import { describe, expect, it } from 'vitest';
import { currentProductCharges, engineLineKey, finalPriceWithPromotion } from '../domain/assignedLineEnginePrices';
import type { BillingSimulationResult, SimulationLine } from '../domain/billingSimulation';

function line(productId: number, actual: number, regular: number, opts: Partial<SimulationLine> = {}): SimulationLine {
  return {
    kind: 'product', label: 'x', user_membership_id: 1, plan_name: null, product_id: productId,
    quantity: 1, unit_price: regular, regular_price: regular, actual_charge: actual,
    benefits: actual !== regular ? [{ source: 'promotion', name: 'P', action: 'percentage_discount', value: 50, period_status: null }] : [],
    price_may_change: false, prepaid_periods: null, ...opts,
  };
}

function sim(events: { date: string; lines: SimulationLine[] }[]): BillingSimulationResult {
  return {
    available: true, reason: null, currency: 'EUR', start_date: null, horizon_date: null, truncated: false,
    sections: [{ section: 'month', events: events.map((e) => ({ ...e, period_end: null, total: 0 })), total: 0 }],
    total: 0,
  };
}

describe('currentProductCharges', () => {
  it('takes the latest charge on or before today, else the first one after', () => {
    const charges = currentProductCharges(sim([
      { date: '2026-09-01', lines: [line(1, 5, 10)] },
      { date: '2026-10-01', lines: [line(1, 10, 10)] },
      { date: '2026-11-01', lines: [line(1, 10, 10), line(2, 3, 6)] },
    ]), '2026-10-15');
    expect(charges.get(engineLineKey(1, null))).toMatchObject({ date: '2026-10-01', promoted: false });
    expect(charges.get(engineLineKey(2, null))).toMatchObject({ date: '2026-11-01', promoted: true });
  });

  it('skips a prorated first charge and the Membership Fee', () => {
    const charges = currentProductCharges(sim([
      { date: '2026-10-10', lines: [line(1, 2, 10, { proration: { prorated_days: 6, period_days: 31 } })] },
      { date: '2026-11-01', lines: [line(1, 10, 10), { ...line(9, 1, 2), kind: 'membership_fee' }] },
    ]), '2026-10-15');
    expect(charges.get(engineLineKey(1, null))?.date).toBe('2026-11-01');
    expect(charges.has(engineLineKey(9, null))).toBe(false);
  });

  it('keeps one charge per member line of the same Product (#2657 stage 3)', () => {
    const charges = currentProductCharges(sim([
      { date: '2026-11-01', lines: [line(1, 10, 10, { assigned_member_id: 7 }), line(1, 5, 10, { assigned_member_id: 8 })] },
    ]), '2026-11-15');
    expect(charges.get(engineLineKey(1, 7))?.actual_charge).toBe(10);
    expect(charges.get(engineLineKey(1, 8))?.actual_charge).toBe(5);
    expect(charges.has(engineLineKey(1, null))).toBe(false);
  });
});

describe('finalPriceWithPromotion', () => {
  const row = { original_price_incl_tax: 12, original_line_price_incl_tax: 24, final_price_incl_tax: 12, final_line_price_incl_tax: 24 };

  it('keeps the row\'s own figures when no Promotion touched the charge', () => {
    expect(finalPriceWithPromotion(row, { date: 'd', quantity: 2, regular_price: 20, actual_charge: 20, promoted: false }))
      .toEqual({ final_price_incl_tax: 12, final_line_price_incl_tax: 24 });
    expect(finalPriceWithPromotion(row, undefined)).toEqual({ final_price_incl_tax: 12, final_line_price_incl_tax: 24 });
  });

  it('scales the gross Original Price by the engine\'s charge ratio (tax carried, units indifferent)', () => {
    // Engine counted 8 renewed units at a frozen €10 net, charged €60 after the Promotion.
    expect(finalPriceWithPromotion(row, { date: 'd', quantity: 8, regular_price: 80, actual_charge: 60, promoted: true }))
      .toEqual({ final_price_incl_tax: 9, final_line_price_incl_tax: 18 });
  });

  it('reads a waived charge as 0 and leaves an unpriced row alone', () => {
    expect(finalPriceWithPromotion(row, { date: 'd', quantity: 1, regular_price: 10, actual_charge: 0, promoted: true }))
      .toEqual({ final_price_incl_tax: 0, final_line_price_incl_tax: 0 });
    const unpriced = { original_price_incl_tax: null, original_line_price_incl_tax: null, final_price_incl_tax: null, final_line_price_incl_tax: null };
    expect(finalPriceWithPromotion(unpriced, { date: 'd', quantity: 1, regular_price: 10, actual_charge: 0, promoted: true }))
      .toEqual({ final_price_incl_tax: null, final_line_price_incl_tax: null });
  });
});
