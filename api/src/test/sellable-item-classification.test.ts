// Unit tests for classifySellableItem/isRecurringFrequency — pure functions,
// no DB dependency. #550 stage 1.

import { describe, expect, it } from 'vitest';
import {
  benefitTableForCategory,
  classifySellableItem,
  isRecurringFrequency,
} from '../domain/sellableItemClassification';

describe('classifySellableItem', () => {
  it('classifies a sessions-type item as session regardless of frequency', () => {
    expect(classifySellableItem({ type: 'sessions', billing_frequency: null })).toBe('session');
    expect(classifySellableItem({ type: 'sessions', billing_frequency: 'month' })).toBe('session');
  });

  it('classifies a non-sessions item with a recurring frequency as periodical', () => {
    expect(classifySellableItem({ type: 'service', billing_frequency: 'month' })).toBe('periodical');
    expect(classifySellableItem({ type: 'service', billing_frequency: 'week' })).toBe('periodical');
    expect(classifySellableItem({ type: 'service', billing_frequency: 'four_weeks' })).toBe('periodical');
    expect(classifySellableItem({ type: 'fee', billing_frequency: 'year' })).toBe('periodical');
  });

  it('classifies a non-sessions item with a non-recurring frequency as oneoff', () => {
    expect(classifySellableItem({ type: 'service', billing_frequency: 'once' })).toBe('oneoff');
    expect(classifySellableItem({ type: 'service', billing_frequency: 'per_session' })).toBe('oneoff');
  });

  it('classifies a non-sessions item with no frequency as oneoff', () => {
    expect(classifySellableItem({ type: 'fee', billing_frequency: null })).toBe('oneoff');
  });

  it('classifies Locker Rental (service, monthly) as periodical, never oneoff', () => {
    expect(classifySellableItem({ type: 'service', billing_frequency: 'month' })).toBe('periodical');
  });
});

describe('isRecurringFrequency', () => {
  it('treats four_weeks/week/month/year as recurring', () => {
    expect(isRecurringFrequency('four_weeks')).toBe(true);
    expect(isRecurringFrequency('week')).toBe(true);
    expect(isRecurringFrequency('month')).toBe(true);
    expect(isRecurringFrequency('year')).toBe(true);
  });

  it('treats once/per_session/null/undefined as not recurring', () => {
    expect(isRecurringFrequency('once')).toBe(false);
    expect(isRecurringFrequency('per_session')).toBe(false);
    expect(isRecurringFrequency(null)).toBe(false);
    expect(isRecurringFrequency(undefined)).toBe(false);
  });
});

describe('benefitTableForCategory', () => {
  it('maps each category to its migration-155 table name', () => {
    expect(benefitTableForCategory('session')).toBe('promotion_session');
    expect(benefitTableForCategory('oneoff')).toBe('promotion_oneoff');
    expect(benefitTableForCategory('periodical')).toBe('promotion_periodical');
  });
});
