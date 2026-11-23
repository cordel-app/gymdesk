// #3282 — a line's explanation names the benefit that set its price. The engine folds every
// benefit over the line, so a Plan line already waived (or discounted 100%) stays at €0.00 under
// a 50% Promotion; the line must not report that 50% Promotion as what took €75.00 off.

import { describe, expect, it } from 'vitest';
import { lineFromSimulation, primaryBenefit } from '../domain/billingEventLines';
import type { SimulationBenefit, SimulationLine } from '../domain/billingSimulation';

const promo50: SimulationBenefit = {
  source: 'promotion', name: 'Noviembre 2026', action: 'percentage_discount', value: 50, period_status: null,
};
const planWaive: SimulationBenefit = {
  source: 'membership_plan', name: null, action: 'waive', value: null, period_status: null,
};
const direct100: SimulationBenefit = {
  source: 'personal', name: null, action: 'percentage_discount', value: 100, period_status: null,
};

const locker = (benefits: SimulationBenefit[], actual: number): SimulationLine => ({
  kind: 'product', source: 'plan', label: 'Locker Rental', user_membership_id: 1, plan_name: 'Plan',
  product_id: 7, quantity: 5, unit_price: 15, regular_price: 75, benefits, actual_charge: actual,
  price_may_change: false, prepaid_periods: null,
} as SimulationLine);

describe('which benefit explains a line (#3282)', () => {
  it('a 50% Promotion alone explains its line, with its own percentage', () => {
    const row = lineFromSimulation(locker([promo50], 37.5));
    expect(row).toMatchObject({
      treatment_action: 'percentage_discount', treatment_value: 50, promotion_name: 'Noviembre 2026', amount: 37.5,
    });
  });

  it('a Plan line already waived is explained by its Waive, not by the 50% Promotion folded over it', () => {
    const row = lineFromSimulation(locker([planWaive, promo50], 0));
    expect(row).toMatchObject({ treatment_action: 'waive', treatment_value: null, promotion_name: null, amount: 0 });
  });

  it('a 100% Direct Discount is what explains a €0.00 line', () => {
    expect(primaryBenefit([promo50, direct100])).toBe(direct100);
    const row = lineFromSimulation(locker([promo50, direct100], 0));
    expect(row).toMatchObject({ treatment_action: 'percentage_discount', treatment_value: 100, promotion_name: null });
  });

  it('a Promotion still outranks a partial Plan discount', () => {
    const planTen: SimulationBenefit = { ...planWaive, action: 'percentage_discount', value: 10 };
    expect(primaryBenefit([planTen, promo50])).toBe(promo50);
  });

  it('a Promotion that waives the line is itself the explanation', () => {
    const promoWaive: SimulationBenefit = { ...promo50, action: 'waive', value: null };
    expect(primaryBenefit([promoWaive])).toBe(promoWaive);
  });
});
