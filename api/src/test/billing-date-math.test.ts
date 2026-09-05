// Unit tests for advanceBillingDate — pure function, no DB dependency.
// #369: '4 Weeks' must advance by exactly 28 days (interval=4, unit='week'),
// never treated as a calendar month.

import { describe, expect, it } from 'vitest';
import { advanceBillingDate } from '../api/billing';

describe('advanceBillingDate', () => {
  it('advances by exactly 28 days for a 4-week interval', () => {
    expect(advanceBillingDate('2026-01-10', 4, 'week')).toBe('2026-02-07');
  });

  it('is not equivalent to a 1-month advance (avoids calendar-month drift)', () => {
    const fourWeeks = advanceBillingDate('2026-01-10', 4, 'week');
    const oneMonth = advanceBillingDate('2026-01-10', 1, 'month');
    expect(fourWeeks).not.toBe(oneMonth);
    expect(fourWeeks).toBe('2026-02-07');
    expect(oneMonth).toBe('2026-02-10');
  });

  it('advances by 7 days for a single week', () => {
    expect(advanceBillingDate('2026-01-10', 1, 'week')).toBe('2026-01-17');
  });

  it('advances by 1 calendar month, handling shorter target months', () => {
    expect(advanceBillingDate('2026-01-31', 1, 'month')).toBe('2026-03-03');
  });

  it('advances by 1 day and 1 year correctly', () => {
    expect(advanceBillingDate('2026-01-10', 1, 'day')).toBe('2026-01-11');
    expect(advanceBillingDate('2026-01-10', 1, 'year')).toBe('2027-01-10');
  });
});
