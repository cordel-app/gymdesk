import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PLAN_BILLING_FREQUENCY,
  PLAN_BILLING_FREQUENCIES,
  PLAN_BILLING_FREQUENCY_CADENCE,
  describeAcceptedPlanCadences,
  isAcceptedPlanCadence,
  isPlanBillingFrequency,
  planBillingFrequencyOf,
} from '../domain/planBillingFrequency';

// #820 — a Membership Plan's Billing frequency is one of two cadences.
//
// Pure module, so no DB and no `createTestGym` (CLAUDE.md). What matters here is
// that the two accepted pairs are exactly Month (1 month) and 4 Weeks (4 week),
// that a pair outside them is reported as such rather than coerced into one of
// them, and that nothing widens the set by accident.

describe('the two Plan-level cadences', () => {
  it('offers exactly Month and 4 Weeks, in that order', () => {
    expect(PLAN_BILLING_FREQUENCIES).toEqual(['month', 'four_weeks']);
  });

  it('stores 1 month and 4 week', () => {
    expect(PLAN_BILLING_FREQUENCY_CADENCE.month).toEqual({ interval: 1, unit: 'month' });
    expect(PLAN_BILLING_FREQUENCY_CADENCE.four_weeks).toEqual({ interval: 4, unit: 'week' });
  });

  it('creates a new Plan monthly', () => {
    expect(DEFAULT_PLAN_BILLING_FREQUENCY).toBe('month');
  });

  it('recognises only its own names', () => {
    expect(isPlanBillingFrequency('month')).toBe(true);
    expect(isPlanBillingFrequency('four_weeks')).toBe(true);
    expect(isPlanBillingFrequency('week')).toBe(false);
    expect(isPlanBillingFrequency('4 weeks')).toBe(false);
    expect(isPlanBillingFrequency(undefined)).toBe(false);
  });
});

describe('planBillingFrequencyOf', () => {
  it('maps each accepted pair back to its choice', () => {
    expect(planBillingFrequencyOf(1, 'month')).toBe('month');
    expect(planBillingFrequencyOf(4, 'week')).toBe('four_weeks');
  });

  it('compares the interval numerically, so a string column still matches', () => {
    expect(planBillingFrequencyOf('1', 'month')).toBe('month');
    expect(planBillingFrequencyOf('4', 'week')).toBe('four_weeks');
  });

  it('answers null for a cadence outside the two rather than coercing it', () => {
    // A Plan configured before #820. The point of `null` is that the screens
    // keep showing what it really bills on instead of relabelling it "Month".
    expect(planBillingFrequencyOf(2, 'month')).toBeNull();
    expect(planBillingFrequencyOf(1, 'week')).toBeNull();
    expect(planBillingFrequencyOf(28, 'day')).toBeNull();
    expect(planBillingFrequencyOf(1, 'year')).toBeNull();
  });

  it('answers null for a missing or nonsense pair', () => {
    expect(planBillingFrequencyOf(null, null)).toBeNull();
    expect(planBillingFrequencyOf(1.5, 'month')).toBeNull();
    expect(planBillingFrequencyOf('many', 'month')).toBeNull();
    expect(planBillingFrequencyOf(1, 'months')).toBeNull();
  });
});

describe('isAcceptedPlanCadence — what the route enforces', () => {
  it('accepts the two and nothing else', () => {
    expect(isAcceptedPlanCadence(1, 'month')).toBe(true);
    expect(isAcceptedPlanCadence(4, 'week')).toBe(true);
    // Every combination the old number-box-plus-unit-list could produce.
    for (const [interval, unit] of [[3, 'day'], [1, 'week'], [2, 'week'], [2, 'month'], [1, 'year'], [0, 'month']] as const) {
      expect(isAcceptedPlanCadence(interval, unit), `${interval} ${unit}`).toBe(false);
    }
  });
});

describe('describeAcceptedPlanCadences', () => {
  it('names both pairs for the 400 message', () => {
    expect(describeAcceptedPlanCadences()).toBe('1 month, 4 week');
  });
});
