// #2490 stage 3 — a Membership Plan Product line's own Direct Discount (%),
// beside its Benefit treatment: judged in one place, taken off last, one line's
// alone, and quoted by the displayed Final Price exactly as the engine bills it.

import { describe, expect, it } from 'vitest';
import { SimulationAssignment, SimulationPlanBenefit } from '../domain/billingSimulation';
import { computeAssignmentBillingEventSimulation } from '../domain/assignmentBillingEventSimulation';
import { NO_PERSONAL_FEE_BENEFIT } from '../domain/personalFeeBenefit';
import { NO_PLAN_DURATION } from '../domain/planDuration';
import {
  applyLineDirectDiscount, parseLineDirectDiscountInput, toLineDirectDiscount,
} from '../domain/lineDirectDiscount';
import { planBenefitPrices } from '../domain/planBenefitPrices';

const TODAY = '2026-11-02';

const line = (over: Partial<SimulationPlanBenefit>): SimulationPlanBenefit => ({
  productId: 1, name: 'Locker', category: 'periodical', billingFrequency: 'month',
  unitPrice: 20, quantity: 1, sessionFrequency: null,
  benefit: { action: 'no_benefit', value: null }, directDiscountPercent: null, ...over,
});

const assignment = (planBenefits: SimulationPlanBenefit[], extra: Partial<SimulationAssignment> = {}): SimulationAssignment => ({
  userMembershipId: 1, planName: 'Plan', startsAt: TODAY, endsAt: null,
  membershipFeePrice: 50, recurringInterval: 1, recurringUnit: 'month',
  promotions: [], services: [], planBenefits,
  planDuration: NO_PLAN_DURATION, personalFeeBenefit: NO_PERSONAL_FEE_BENEFIT,
  ...extra,
});

const chargesOf = (a: SimulationAssignment, label: string) =>
  computeAssignmentBillingEventSimulation({ assignment: a, from: TODAY }).dates
    .flatMap((g) => g.lines.filter((l) => l.label === label).map((l) => l.actual_charge));

describe('parseLineDirectDiscountInput', () => {
  it('keeps when the key is absent, clears on null/blank, sets 0..100', () => {
    expect(parseLineDirectDiscountInput({ product_id: 1 })).toEqual({ keep: true });
    expect(parseLineDirectDiscountInput({ direct_discount_percent: null })).toEqual({ keep: false, percent: null });
    expect(parseLineDirectDiscountInput({ direct_discount_percent: '' })).toEqual({ keep: false, percent: null });
    expect(parseLineDirectDiscountInput({ direct_discount_percent: '15' })).toEqual({ keep: false, percent: 15 });
    expect(parseLineDirectDiscountInput({ direct_discount_percent: 0 })).toEqual({ keep: false, percent: null });
  });

  it('refuses rather than coerces anything outside 0..100', () => {
    for (const v of [-1, 101, 'abc', true, {}]) {
      expect(parseLineDirectDiscountInput({ direct_discount_percent: v }).error).toBeTruthy();
    }
  });

  it('reads a stored DECIMAL string back as a number, and none as null', () => {
    expect(toLineDirectDiscount('12.50')).toBe(12.5);
    expect(toLineDirectDiscount(null)).toBeNull();
    expect(toLineDirectDiscount('0.00')).toBeNull();
    expect(applyLineDirectDiscount(80, 25)).toBe(60);
    expect(applyLineDirectDiscount(80, null)).toBe(80);
  });
});

describe('the engine prices a Plan line with its own Direct Discount', () => {
  it('takes the percentage off every cycle of a recurring line and leaves the fee alone', () => {
    const a = assignment([line({ directDiscountPercent: 25 })]);
    expect(chargesOf(a, 'Locker').every((c) => c === 15)).toBe(true);
    expect(chargesOf(assignment([line({})]), 'Locker').every((c) => c === 20)).toBe(true);
    const fee = (x: SimulationAssignment) => computeAssignmentBillingEventSimulation({ assignment: x, from: TODAY })
      .dates.flatMap((g) => g.lines.filter((l) => l.kind === 'membership_fee').map((l) => l.actual_charge));
    expect(fee(a)).toEqual(fee(assignment([line({})])));
  });

  it('is applied after the Benefit treatment, and is independent per line', () => {
    const a = assignment([
      line({ productId: 1, name: 'Locker', benefit: { action: 'percentage_discount', value: 50 }, directDiscountPercent: 10 }),
      line({ productId: 2, name: 'Towel', unitPrice: 10, directDiscountPercent: null }),
    ]);
    // 20 → 50% treatment → 10 → 10% direct → 9
    expect(chargesOf(a, 'Locker')[0]).toBe(9);
    expect(chargesOf(a, 'Towel')[0]).toBe(10);
  });

  it('applies to a one-off line, and is reported apart from a Promotion', () => {
    const a = assignment([line({ productId: 3, name: 'Kit', category: 'oneoff', billingFrequency: 'once', unitPrice: 40, quantity: 2, directDiscountPercent: 50 })]);
    const r = computeAssignmentBillingEventSimulation({ assignment: a, from: TODAY });
    const kit = r.dates.flatMap((g) => g.lines).find((l) => l.label === 'Kit');
    expect(kit?.actual_charge).toBe(40);
    expect(kit?.benefits).toContainEqual(expect.objectContaining({ source: 'personal', action: 'percentage_discount', value: 50 }));
  });

  it('a waived line stays free', () => {
    const a = assignment([line({ benefit: { action: 'waive', value: null }, directDiscountPercent: 30 })]);
    expect(chargesOf(a, 'Locker').every((c) => c === 0)).toBe(true);
  });
});

describe('the displayed Final Price matches what the engine bills', () => {
  it('quotes the treatment then the Direct Discount', () => {
    const p = planBenefitPrices(20, 3, { action: 'percentage_discount', value: 50 }, 10);
    expect(p.original_line_price_incl_tax).toBe(60);
    expect(p.final_price_incl_tax).toBe(9);
    expect(p.final_line_price_incl_tax).toBe(27);
    expect(planBenefitPrices(20, 1, { action: 'no_benefit', value: null }).final_price_incl_tax).toBe(20);
  });
});
