// #3284 — a line's treatments are classified by where they came from, never by their action.
import { describe, expect, it } from 'vitest';
import { lineFromSimulation, lineReasons } from '../domain/billingEventLines';
import { chargeLineView, initialPaymentBreakdown } from '../domain/checkoutSummary';
import type { SimulationBenefit, SimulationLine } from '../domain/billingSimulation';

const b = (over: Partial<SimulationBenefit>): SimulationBenefit =>
  ({ source: 'membership_plan', name: null, action: 'waive', value: null, period_status: null, ...over });

describe('lineReasons (#3284)', () => {
  it('a Plan treatment is a Benefit and a Promotion is a Discount, a waive included', () => {
    expect(lineReasons([b({}), b({ source: 'promotion', name: 'Spring', action: 'waive' })]).map((r) => [r.type, r.name]))
      .toEqual([['benefit', null], ['discount', 'Spring']]);
  });

  it('a Promotion percentage stays a Discount; only explicit evidence makes a Manual adjustment', () => {
    const reasons = lineReasons([
      b({ source: 'promotion', name: 'Half', action: 'percentage_discount', value: 50 }),
      b({ source: 'personal', action: 'percentage_discount', value: 15, code: 'direct_discount' }),
      b({ source: 'personal', action: 'percentage_discount', value: 5, code: 'personal_fee_benefit' }),
    ]);
    expect(reasons.map((r) => [r.type, r.code])).toEqual([
      ['discount', null], ['manual_adjustment', 'direct_discount'], ['manual_adjustment', 'personal_fee_benefit'],
    ]);
  });

  it('a treatment that changes nothing and a Pre-paid period are not reasons; `included` reads as waive', () => {
    const reasons = lineReasons([
      b({ action: 'no_benefit' }), b({ period_status: 'prepaid_plan' }), b({ source: 'promotion', name: 'P', action: 'included' }),
    ]);
    expect(reasons).toEqual([{ type: 'discount', source: 'promotion', code: null, action: 'waive', value: null, name: 'P' }]);
  });

  it('the line, the review shape and the Initial Payment carry every reason in order', () => {
    const line: SimulationLine = {
      kind: 'product', source: 'plan', label: 'Kit', user_membership_id: 1, plan_name: 'P', product_id: 1,
      quantity: 1, unit_price: 100, regular_price: 100, actual_charge: 36, price_may_change: false, prepaid_periods: null,
      benefits: [
        b({ source: 'promotion', name: 'Half', action: 'percentage_discount', value: 50 }),
        b({ action: 'percentage_discount', value: 20 }),
        b({ source: 'personal', action: 'percentage_discount', value: 10, code: 'direct_discount' }),
      ],
    } as SimulationLine;
    const row = lineFromSimulation(line);
    expect(row.promotion_name).toBe('Half');
    expect(row.reasons.map((r) => r.type)).toEqual(['discount', 'benefit', 'manual_adjustment']);
    const payment = initialPaymentBreakdown([chargeLineView(row)], 36);
    expect(payment.lines[0].reasons).toEqual(row.reasons);
  });

  it('a stored reason row reads as the same reason (`reason_type` / `reason_code` columns)', () => {
    const view = chargeLineView({
      item_name: 'X', quantity: 1, amount: 1,
      reasons: [{ reason_type: 'manual_adjustment', source: 'personal', reason_code: 'direct_discount', action: 'percentage_discount', value: '10.00', name: null },
        { reason_type: 'bogus', source: 'personal', action: 'x' }],
    });
    expect(view.reasons).toEqual([{ type: 'manual_adjustment', source: 'personal', code: 'direct_discount', action: 'percentage_discount', value: 10, name: null }]);
  });

  it('#3282 — a Promotion reason carries its duration; no other reason does', () => {
    const reasons = lineReasons([
      b({ source: 'promotion', name: 'Half', action: 'percentage_discount', value: 50, duration: { count: 3, unit: 'month' } }),
      b({ action: 'percentage_discount', value: 20, duration: { count: 2, unit: 'month' } }),
    ]);
    expect(reasons[0].duration).toEqual({ count: 3, unit: 'month' });
    expect(reasons[1]).not.toHaveProperty('duration');
  });

  it('#3282 — a stored reason reads its duration columns, and an invalid one reads as none', () => {
    const view = chargeLineView({
      item_name: 'X', quantity: 1, amount: 1,
      reasons: [
        { reason_type: 'discount', source: 'promotion', action: 'percentage_discount', value: '50.00', name: 'Half', duration_count: 3, duration_unit: 'month' },
        { reason_type: 'discount', source: 'promotion', action: 'waive', value: null, name: 'Old', duration_count: null, duration_unit: null },
        { reason_type: 'discount', source: 'promotion', action: 'waive', value: null, name: 'Bad', duration_count: 2, duration_unit: 'once' },
      ],
    });
    expect(view.reasons?.map((r) => r.duration ?? null)).toEqual([{ count: 3, unit: 'month' }, null, null]);
  });
});
