import { describe, expect, it } from 'vitest';
import { diffConfigurations, financialSummary, itemFinalPrice, recurringFinalPrices, recurringLinesOf, summaryItems } from '../domain/productSetDiff';

const svc = (productId: number, quantity: number, unitPrice = 10, endsOn: string | null = null) => ({
  id: productId, productId, name: `P${productId}`, billingFrequency: 'month', unitPrice, quantity, startsOn: '2026-01-01', endsOn,
});
const asg = (services: any[], extra: any = {}): any => ({
  planName: 'Plan', membershipFeePrice: 40, promotions: [], planBenefits: [], services, ...extra,
});

describe('diffConfigurations (#1537)', () => {
  it('treats everything as added when there is no previous configuration', () => {
    const out = diffConfigurations(null, asg([svc(1, 1)]));
    expect(out.map((c) => c.kind).sort()).toEqual(['added', 'plan_changed']);
  });

  it('reports a first Membership Plan as a change even with no recurring lines (#2097)', () => {
    expect(diffConfigurations(null, asg([]))).toEqual([{ kind: 'plan_changed', from: null, to: 'Plan' }]);
    expect(diffConfigurations(null, asg([], { planName: null }))).toEqual([]);
  });

  it('reports added, removed, quantity and price changes and ignores ended lines', () => {
    const before = asg([svc(1, 1), svc(2, 1), svc(3, 1, 10, '2026-02-01')]);
    const after = asg([svc(1, 3), svc(4, 1), svc(2, 1, 12)]);
    const kinds = diffConfigurations(before, after).map((c) => `${c.kind}`).sort();
    expect(kinds).toEqual(['added', 'price_changed', 'quantity_changed']);
    expect(recurringLinesOf(before)).toHaveLength(2);
  });

  it('reports removals, plan and fee changes and promotions', () => {
    const before = asg([svc(1, 1)], { promotions: [{ name: 'A', revokedAt: null }] });
    const after = asg([], { planName: 'Other', membershipFeePrice: 50, promotions: [{ name: 'B', revokedAt: null }] });
    const kinds = diffConfigurations(before, after).map((c) => c.kind).sort();
    expect(kinds).toEqual(['fee_changed', 'plan_changed', 'promotion_added', 'promotion_removed', 'removed']);
  });

  it('reports nothing for an unchanged configuration', () => {
    expect(diffConfigurations(asg([svc(1, 2)]), asg([svc(1, 2)]))).toEqual([]);
  });

  it('keeps two purchases of one Product apart by their lineRef (#1865)', () => {
    const line = (id: number, lineRef: number | null, quantity = 1) => ({ ...svc(7, quantity), id, lineRef });
    const before = asg([line(10, 10), line(11, 11)]);
    // The cloned version has new ids but the same lineRef: nothing changed.
    expect(diffConfigurations(before, asg([line(20, 10), line(21, 11)]))).toEqual([]);
    // Removing one purchase reports exactly that one.
    const removed = diffConfigurations(before, asg([line(21, 11)]));
    expect(removed).toEqual([expect.objectContaining({ kind: 'removed', line: expect.objectContaining({ key: 'service-ref-10' }) })]);
    // A line that predates lineRef is still the Product's one line.
    expect(diffConfigurations(asg([line(30, null)]), asg([line(31, null, 2)]))).toEqual([
      expect.objectContaining({ kind: 'quantity_changed' }),
    ]);
  });
});

describe('summaryItems (#2446)', () => {
  it('lists active, draft and cancelling items with the plan', () => {
    const before = asg([svc(1, 1), svc(2, 1)]);
    const after = asg([svc(1, 1), svc(3, 2)]);
    const out = summaryItems(before, after).map((i) => `${i.type}:${i.name}:${i.state}`);
    expect(out).toEqual(['plan:Plan:active', 'product:P1:active', 'product:P3:draft', 'product:P2:cancelling']);
  });

  it('shows a replaced plan as cancelling beside the new draft one, and a first plan as draft', () => {
    expect(summaryItems(asg([]), asg([], { planName: 'New' })).map((i) => `${i.name}:${i.state}`)).toEqual(['Plan:cancelling', 'New:draft']);
    expect(summaryItems(null, asg([])).map((i) => i.state)).toEqual(['draft']);
  });
});

describe('Summary financial view (#2446 stage 3)', () => {
  const fee = (actual: number, extra: any = {}) => ({ kind: 'membership_fee' as const, label: 'Fee', actual_charge: actual, prepaid_periods: null, ...extra });
  const prod = (label: string, actual: number, extra: any = {}) => ({ kind: 'product' as const, label, actual_charge: actual, prepaid_periods: null, ...extra });

  it('takes each item\'s first ordinary charge, passing over a prorated or pre-paid one', () => {
    const prices = recurringFinalPrices([
      { date: '2026-12-01', lines: [fee(30), prod('Locker', 10)] },
      { date: '2026-11-15', lines: [prod('Locker', 5, { proration: { prorated_days: 15, period_days: 31 } }), fee(90, { prepaid_periods: 3 })] },
    ]);
    expect(prices.fee).toBe(30);
    expect(prices.products.get('Locker')).toBe(10);
    expect(itemFinalPrice({ type: 'plan', name: 'Plan' }, prices)).toBe(30);
    expect(itemFinalPrice({ type: 'product', name: 'Towel' }, prices)).toBeNull();
    expect(itemFinalPrice({ type: 'product', name: 'Locker' }, null)).toBeNull();
  });

  it('falls back to a prorated charge when it is the only one', () => {
    const prices = recurringFinalPrices([{ date: '2026-11-15', lines: [prod('Locker', 5, { proration: { prorated_days: 15, period_days: 31 } })] }]);
    expect(prices.products.get('Locker')).toBe(5);
  });

  it('totals per frequency and reports the initial discounts and the amount payable unchanged', () => {
    const out = financialSummary([
      { state: 'active', billing_frequency: '1_month', final_price: 40 },
      { state: 'draft', billing_frequency: 'month', final_price: 10 },
      { state: 'active', billing_frequency: 'month', final_price: 5 },
      { state: 'cancelling', billing_frequency: 'month', final_price: 7 },
      { state: 'draft', billing_frequency: 'year', final_price: null },
    ], [
      { quantity: 2, amount: 16, regular_unit_price: 10 },
      { quantity: 1, amount: 30, regular_unit_price: null },
    ], 46);
    expect(out.recurring).toEqual([
      { billing_frequency: '1_month', existing: 40, new: 0, cancelling: 0, resulting: 40 },
      { billing_frequency: 'month', existing: 5, new: 10, cancelling: 7, resulting: 15 },
    ]);
    expect(out.initial_discounts).toBe(4);
    expect(out.amount_payable).toBe(46);
    expect(out.initial_payment).toBe(46);
  });
});
