// Unit tests for computePromotionTimeline / validatePayBeforehandMonths — pure
// functions, no DB dependency. #486.

import { describe, expect, it } from 'vitest';
import { computePromotionTimeline, validatePayBeforehandMonths } from '../domain/promotionTimeline';

describe('validatePayBeforehandMonths', () => {
  it('rejects negative values', () => {
    expect(validatePayBeforehandMonths(2, -1)).toBeTruthy();
  });

  it('rejects pay_beforehand_months greater than paid_months', () => {
    expect(validatePayBeforehandMonths(2, 3)).toBeTruthy();
  });

  it('rejects any pay_beforehand_months when paid_months is 0', () => {
    expect(validatePayBeforehandMonths(0, 1)).toBeTruthy();
  });

  it('accepts 0', () => {
    expect(validatePayBeforehandMonths(2, 0)).toBeNull();
  });

  it('accepts a value equal to paid_months', () => {
    expect(validatePayBeforehandMonths(2, 2)).toBeNull();
  });

  it('accepts a value between 0 and paid_months', () => {
    expect(validatePayBeforehandMonths(3, 1)).toBeNull();
  });
});

describe('computePromotionTimeline', () => {
  it('ticket example 9 — no pay beforehand', () => {
    // Free: 1, Paid: 2, Pay Beforehand: 0, Bonus: 1
    const { periods } = computePromotionTimeline(
      { freeMonths: 1, paidMonths: 2, payBeforehandMonths: 0, bonusMonths: 1 },
      '2026-01-01',
    );
    expect(periods.map((p) => p.status)).toEqual([
      'free_promotion',
      'pay_promotion',
      'pay_promotion',
      'bonus_promotion',
      'pay_regular',
    ]);
    // Last period is open-ended
    expect(periods[periods.length - 1].endsOn).toBeNull();
  });

  it('ticket example 26 — complete timeline with partial pay beforehand', () => {
    // Free: 1, Paid: 3, Pay Beforehand: 2, Bonus: 1
    const { periods } = computePromotionTimeline(
      { freeMonths: 1, paidMonths: 3, payBeforehandMonths: 2, bonusMonths: 1 },
      '2026-01-01',
    );
    expect(periods.map((p) => p.status)).toEqual([
      'free_promotion',
      'prepaid_promotion',
      'prepaid_promotion',
      'pay_promotion',
      'bonus_promotion',
      'pay_regular',
    ]);
  });

  it('ticket example 27 — no bonus', () => {
    // Free: 1, Paid: 2, Pay Beforehand: 1, Bonus: 0
    const { periods } = computePromotionTimeline(
      { freeMonths: 1, paidMonths: 2, payBeforehandMonths: 1, bonusMonths: 0 },
      '2026-01-01',
    );
    expect(periods.map((p) => p.status)).toEqual([
      'free_promotion',
      'prepaid_promotion',
      'pay_promotion',
      'pay_regular',
    ]);
  });

  it('ticket example 28 — everything paid beforehand, no pay (promotion) period', () => {
    // Free: 0, Paid: 3, Pay Beforehand: 3, Bonus: 2
    const { periods } = computePromotionTimeline(
      { freeMonths: 0, paidMonths: 3, payBeforehandMonths: 3, bonusMonths: 2 },
      '2026-01-01',
    );
    expect(periods.map((p) => p.status)).toEqual([
      'prepaid_promotion',
      'prepaid_promotion',
      'prepaid_promotion',
      'bonus_promotion',
      'bonus_promotion',
      'pay_regular',
    ]);
    expect(periods.some((p) => p.status === 'pay_promotion')).toBe(false);
  });

  it('forecast length is free + paid + bonus + 1', () => {
    const { periods } = computePromotionTimeline(
      { freeMonths: 2, paidMonths: 4, payBeforehandMonths: 1, bonusMonths: 3 },
      '2026-01-01',
    );
    expect(periods).toHaveLength(2 + 4 + 3 + 1);
  });

  it('produces contiguous, non-overlapping monthly date ranges', () => {
    const { periods } = computePromotionTimeline(
      { freeMonths: 1, paidMonths: 1, payBeforehandMonths: 0, bonusMonths: 1 },
      '2026-01-01',
    );
    expect(periods[0].startsOn).toBe('2026-01-01');
    expect(periods[0].endsOn).toBe('2026-01-31');
    expect(periods[1].startsOn).toBe('2026-02-01');
    expect(periods[1].endsOn).toBe('2026-02-28');
    expect(periods[2].startsOn).toBe('2026-03-01');
    expect(periods[2].endsOn).toBe('2026-03-31');
    expect(periods[3].startsOn).toBe('2026-04-01');
    expect(periods[3].endsOn).toBeNull();
  });

  it('clamps pay_beforehand_months to paid_months when it would exceed it', () => {
    const { periods } = computePromotionTimeline(
      { freeMonths: 0, paidMonths: 2, payBeforehandMonths: 99, bonusMonths: 0 },
      '2026-01-01',
    );
    expect(periods.map((p) => p.status)).toEqual(['prepaid_promotion', 'prepaid_promotion', 'pay_regular']);
  });

  it('with everything at 0, only the regular period is produced', () => {
    const { periods } = computePromotionTimeline(
      { freeMonths: 0, paidMonths: 0, payBeforehandMonths: 0, bonusMonths: 0 },
      '2026-01-01',
    );
    expect(periods).toHaveLength(1);
    expect(periods[0].status).toBe('pay_regular');
    expect(periods[0].endsOn).toBeNull();
  });
});
