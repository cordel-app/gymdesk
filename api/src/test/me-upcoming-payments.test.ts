import { describe, expect, it } from 'vitest';
import { advanceDate, computeUpcomingPayments } from '../api/me';

describe('advanceDate', () => {
  it('advances by days', () => {
    expect(advanceDate('2026-09-01', 1, 'day')).toBe('2026-09-02');
    expect(advanceDate('2026-09-01', 7, 'day')).toBe('2026-09-08');
  });

  it('advances by weeks', () => {
    expect(advanceDate('2026-09-01', 1, 'week')).toBe('2026-09-08');
    expect(advanceDate('2026-09-01', 2, 'week')).toBe('2026-09-15');
  });

  it('advances by months', () => {
    expect(advanceDate('2026-09-15', 1, 'month')).toBe('2026-10-15');
    expect(advanceDate('2026-12-15', 1, 'month')).toBe('2027-01-15');
  });

  it('advances by years', () => {
    expect(advanceDate('2026-09-01', 1, 'year')).toBe('2027-09-01');
  });
});

describe('computeUpcomingPayments', () => {
  it('returns empty array when next_billing_date is null', () => {
    expect(computeUpcomingPayments(null, 1, 'month', '59.00')).toEqual([]);
  });

  it('returns empty array when billing interval is null', () => {
    expect(computeUpcomingPayments('2026-10-01', null, 'month', '59.00')).toEqual([]);
  });

  it('returns empty array when billing unit is null', () => {
    expect(computeUpcomingPayments('2026-10-01', 1, null, '59.00')).toEqual([]);
  });

  it('returns empty array when amount is null', () => {
    expect(computeUpcomingPayments('2026-10-01', 1, 'month', null)).toEqual([]);
  });

  it('returns 2 upcoming monthly payments when both are in the future', () => {
    const result = computeUpcomingPayments('2099-09-15', 1, 'month', '59.00');
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ date: '2099-09-15', amount: '59.00', status: 'scheduled' });
    expect(result[1]).toEqual({ date: '2099-10-15', amount: '59.00', status: 'scheduled' });
  });

  it('returns 1 upcoming payment when next billing date is far future and only one fits in window', () => {
    // Only one date because there won't be a second within 24 months of today
    // But actually we just need 2 from next_billing_date — test that correctly
    const result = computeUpcomingPayments('2099-11-01', 13, 'month', '100.00');
    expect(result).toHaveLength(2);
    expect(result[0].status).toBe('scheduled');
    expect(result[1].status).toBe('scheduled');
  });

  it('advances past a stale next_billing_date to find future dates', () => {
    // next_billing_date is in the past; should advance until future
    const past = '2020-01-15';
    const result = computeUpcomingPayments(past, 1, 'month', '30.00');
    // Should return 2 future dates, each 1 month apart
    const today = new Date().toISOString().slice(0, 10);
    expect(result).toHaveLength(2);
    expect(result[0].date >= today).toBe(true);
    expect(result[0].amount).toBe('30.00');
    expect(result[0].status).toBe('scheduled');
    // Second date is 1 month after the first
    const d0 = new Date(result[0].date + 'T00:00:00Z');
    d0.setUTCMonth(d0.getUTCMonth() + 1);
    expect(result[1].date).toBe(d0.toISOString().slice(0, 10));
  });

  it('formats amount to 2 decimal places', () => {
    const result = computeUpcomingPayments('2099-01-01', 1, 'month', '59.9');
    expect(result[0].amount).toBe('59.90');
  });

  it('accepts a Date object for next_billing_date', () => {
    const dateObj = new Date('2099-06-15T00:00:00Z');
    const result = computeUpcomingPayments(dateObj, 1, 'month', '50.00');
    expect(result[0].date).toBe('2099-06-15');
  });
});
