// #916 — the Original / Final Price pair a Membership Plan Benefit row reports.
//
// A unit test, because `planBenefitPrices()` touches no DB and no HTTP: it takes
// the item's gross unit price, the row's quantity and the row's `(action,
// value)` pair, and reports the four amounts the card shows. What it must never
// do is compute a discount of its own — every figure below is `applyLineBenefit()`
// (#896), which is the same function the Billing Simulation's charge builders
// call, so the Benefit sections and the Billing Event Simulation on the same
// card cannot quote one line two ways.

import { describe, expect, it } from 'vitest';
import { planBenefitPrices } from '../domain/planBenefitPrices';
import {
  NO_SELLABLE_ITEM_BENEFIT,
  SellableItemBenefit,
} from '../domain/sellableItemBenefitActions';

const waive: SellableItemBenefit = { action: 'waive', value: null };
const percent = (value: number): SellableItemBenefit => ({ action: 'percentage_discount', value });

describe('planBenefitPrices()', () => {
  it('reports the item price unchanged when the Plan configures no benefit', () => {
    expect(planBenefitPrices(100, 1, NO_SELLABLE_ITEM_BENEFIT)).toEqual({
      original_price_incl_tax: 100,
      final_price_incl_tax: 100,
      original_line_price_incl_tax: 100,
      final_line_price_incl_tax: 100,
    });
  });

  it('prices a waived item at 0 and keeps the original visible', () => {
    // The ticket's own example: a waived €20 Insurance Fee reads €20.00 → €0.00.
    const prices = planBenefitPrices(20, 1, waive);
    expect(prices.original_price_incl_tax).toBe(20);
    expect(prices.final_price_incl_tax).toBe(0);
  });

  it('applies a percentage discount', () => {
    // €70 at 20% off — the ticket's tax example, gross in and gross out.
    expect(planBenefitPrices(70, 1, percent(20)).final_price_incl_tax).toBe(56);
  });

  it('reports the line beside the unit, so the two cannot disagree', () => {
    const prices = planBenefitPrices(25, 5, NO_SELLABLE_ITEM_BENEFIT);
    expect(prices.original_price_incl_tax).toBe(25);
    expect(prices.original_line_price_incl_tax).toBe(125);
    expect(prices.final_line_price_incl_tax).toBe(125);
  });

  it('applies the treatment to the line as `applyLineBenefit()` does', () => {
    const prices = planBenefitPrices(25, 5, percent(10));
    expect(prices.final_price_incl_tax).toBe(22.5);
    // 125 − 10% — the line, never five roundings of the unit.
    expect(prices.final_line_price_incl_tax).toBe(112.5);
  });

  it('reports nothing at all for an item with no price', () => {
    for (const noPrice of [null, undefined]) {
      expect(planBenefitPrices(noPrice, 2, waive)).toEqual({
        original_price_incl_tax: null,
        final_price_incl_tax: null,
        original_line_price_incl_tax: null,
        final_line_price_incl_tax: null,
      });
    }
  });

  it('reports 0 for an item priced at 0 — which is not the same as having no price', () => {
    const prices = planBenefitPrices(0, 1, NO_SELLABLE_ITEM_BENEFIT);
    expect(prices.original_price_incl_tax).toBe(0);
    expect(prices.final_price_incl_tax).toBe(0);
  });

  it('rounds to the cent', () => {
    expect(planBenefitPrices(19.999, 1, NO_SELLABLE_ITEM_BENEFIT).original_price_incl_tax).toBe(20);
    expect(planBenefitPrices(10, 3, percent(33.333)).final_line_price_incl_tax).toBe(20);
  });

  it('survives a quantity that is not a positive integer', () => {
    // The route refuses one, so this is only about never reporting NaN.
    for (const quantity of [0, -3, Number.NaN, 1.6]) {
      const prices = planBenefitPrices(10, quantity, NO_SELLABLE_ITEM_BENEFIT);
      expect(Number.isFinite(prices.original_line_price_incl_tax as number)).toBe(true);
      expect(Number.isFinite(prices.final_line_price_incl_tax as number)).toBe(true);
      // The unit price is the item's own and is unaffected by a bad quantity.
      expect(prices.original_price_incl_tax).toBe(10);
    }
  });
});
