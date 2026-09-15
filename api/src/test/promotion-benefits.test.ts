// Unit tests for applyPeriodBenefit — pure function, no DB dependency. #487 stage 2.

import { describe, expect, it } from 'vitest';
import { applyPeriodBenefit } from '../domain/promotionBenefits';

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
