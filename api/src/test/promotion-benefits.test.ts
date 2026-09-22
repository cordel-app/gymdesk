// Unit tests for applyPeriodBenefit — pure function, no DB dependency. #487 stage 2.

import { describe, expect, it } from 'vitest';
import {
  applyPeriodBenefit,
  promotionDurationMonths,
  effectiveBenefitDurationMonths,
} from '../domain/promotionBenefits';

describe('applyPeriodBenefit', () => {
  it('passes the amount through unchanged for no_benefit', () => {
    expect(applyPeriodBenefit(100, 'no_benefit', null)).toBe(100);
  });

  it('zeroes out the amount for a waive benefit', () => {
    expect(applyPeriodBenefit(100, 'waive', null)).toBe(0);
  });

  it('applies a percentage discount', () => {
    expect(applyPeriodBenefit(100, 'percentage_discount', 50)).toBe(50);
  });

  it('applies a fixed discount', () => {
    expect(applyPeriodBenefit(100, 'fixed_discount', 20)).toBe(80);
  });

  it('clamps a fixed discount larger than the amount at 0', () => {
    expect(applyPeriodBenefit(10, 'fixed_discount', 25)).toBe(0);
  });

  it('replaces the amount with a fixed price', () => {
    expect(applyPeriodBenefit(100, 'fixed_price', 60)).toBe(60);
  });

  it('clamps a negative fixed price at 0', () => {
    expect(applyPeriodBenefit(100, 'fixed_price', -5)).toBe(0);
  });

  it('rounds to 2 decimal places', () => {
    expect(applyPeriodBenefit(100, 'percentage_discount', 33.333)).toBe(66.67);
  });
});

// #625: a Promotion Period Benefit belongs to the Promotion lifecycle and can
// never outlast it. These pure helpers are the single source of truth for the
// ceiling.
describe('promotionDurationMonths', () => {
  it('sums free + paid + bonus (the ticket example: 1 + 2 + 2 = 5)', () => {
    expect(promotionDurationMonths(1, 2, 2)).toBe(5);
  });

  it('is NOT based on paid_months alone', () => {
    // The incorrect formula would return 2 here; the correct one returns 5.
    expect(promotionDurationMonths(1, 2, 2)).not.toBe(2);
  });

  it('treats null/undefined months as 0', () => {
    expect(promotionDurationMonths(null, 3, null)).toBe(3);
    expect(promotionDurationMonths(null, null, null)).toBe(0);
  });

  it('never counts negative months', () => {
    expect(promotionDurationMonths(-4, 2, 1)).toBe(3);
  });
});

describe('effectiveBenefitDurationMonths', () => {
  it('returns the configured duration when it is below the promotion duration', () => {
    expect(effectiveBenefitDurationMonths(3, 5)).toBe(3);
  });

  it('returns the promotion duration when the configured duration equals it', () => {
    expect(effectiveBenefitDurationMonths(5, 5)).toBe(5);
  });

  it('caps the configured duration at the promotion duration (7 → 5)', () => {
    expect(effectiveBenefitDurationMonths(7, 5)).toBe(5);
  });

  it('treats a null (unbounded) configured duration as the whole promotion', () => {
    expect(effectiveBenefitDurationMonths(null, 5)).toBe(5);
  });

  it('is 0 when the promotion has no duration, so the benefit never applies', () => {
    expect(effectiveBenefitDurationMonths(7, 0)).toBe(0);
    expect(effectiveBenefitDurationMonths(null, 0)).toBe(0);
  });
});
