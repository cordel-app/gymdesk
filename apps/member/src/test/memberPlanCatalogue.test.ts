import { describe, expect, it } from 'vitest';
import {
  assignErrorKey, choosingOwesNothing, planFinalPrice, planFinalPriceText, planFrequencyKey,
  planPriceText, planPromotionBenefitNote, planPromotionDurationNote, type MemberPlanOffer,
} from '../lib/memberPlanCatalogue';

// #1122 §1–§6 — the decide half of Add Plan: keys and formatting only.

const plan: MemberPlanOffer = {
  id: 7, name: 'Premium', description: null, price_incl_tax: 100, tax_included: true,
  billing_interval: 1, billing_unit: 'month',
  promotions: [
    { id: 3, name: 'Half off', benefit: { action: 'percentage_discount', value: 50 }, duration_months: 3, final_price_incl_tax: 50 },
    { id: 4, name: 'First month free', benefit: { action: 'waive', value: null }, duration_months: 1, final_price_incl_tax: 0 },
  ],
};

describe('memberPlanCatalogue', () => {
  it('reads the cadence under the one frequency map, and spells an unknown pair as nothing', () => {
    expect(planFrequencyKey(plan)).toBe('membership.frequency.month');
    expect(planFrequencyKey({ billing_interval: 4, billing_unit: 'week' })).toBe('membership.frequency.four_weeks');
    expect(planFrequencyKey({ billing_interval: 2, billing_unit: 'month' })).toBeNull();
    expect(planFrequencyKey({ billing_interval: null, billing_unit: null })).toBeNull();
  });

  it('formats the catalogue price and the applied Promotion\'s own final price, never computing one', () => {
    expect(planPriceText(plan, 'en')).toMatch(/100/);
    expect(planPriceText({ price_incl_tax: null }, 'en')).toBeNull();
    expect(planFinalPrice(plan, null)).toBe(100);
    expect(planFinalPrice(plan, 3)).toBe(50);
    expect(planFinalPrice(plan, 999)).toBe(100);
    expect(planFinalPriceText(plan, 4, 'en')).toMatch(/0/);
  });

  it('words a Promotion with the Products\' own keys, and its duration in months', () => {
    expect(planPromotionBenefitNote(plan.promotions[0], 'en')).toEqual({ key: 'membership.promotion_benefit_percentage', values: { value: '50' } });
    expect(planPromotionBenefitNote(plan.promotions[1], 'en')).toEqual({ key: 'membership.promotion_benefit_waive' });
    expect(planPromotionDurationNote(plan.promotions[0])).toEqual({ key: 'membership.promotion_duration_months', values: { count: 3 } });
    expect(planPromotionDurationNote({ ...plan.promotions[0], duration_months: null })).toBeNull();
  });

  it('knows when a choice owes nothing, and which key a refusal reads under', () => {
    expect(choosingOwesNothing(plan, null)).toBe(false);
    expect(choosingOwesNothing(plan, 4)).toBe(true);
    expect(assignErrorKey('active_plan_exists')).toBe('membership.add_plan_replace_body');
    expect(assignErrorKey('plan_pending_payment')).toBe('membership.add_plan_pending_error');
    expect(assignErrorKey('whatever')).toBe('membership.add_plan_error');
  });
});
