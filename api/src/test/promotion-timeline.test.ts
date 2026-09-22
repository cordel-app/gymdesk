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

  it('billingAction/billingValue default to null when no Membership Fee Benefit is configured', () => {
    const { periods } = computePromotionTimeline(
      { freeMonths: 1, paidMonths: 2, payBeforehandMonths: 0, bonusMonths: 1 },
      '2026-01-01',
    );
    expect(periods.every((p) => p.billingAction === null && p.billingValue === null)).toBe(true);
  });

  it('applies the Membership Fee Benefit only to pay_promotion/prepaid_promotion periods', () => {
    const { periods } = computePromotionTimeline(
      {
        freeMonths: 1, paidMonths: 2, payBeforehandMonths: 1, bonusMonths: 1,
        membershipFeeAction: 'percentage_discount', membershipFeeValue: 50, membershipFeeEnabled: true,
      },
      '2026-01-01',
    );
    expect(periods.map((p) => ({ status: p.status, billingAction: p.billingAction, billingValue: p.billingValue }))).toEqual([
      { status: 'free_promotion', billingAction: null, billingValue: null },
      { status: 'prepaid_promotion', billingAction: 'percentage_discount', billingValue: 50 },
      { status: 'pay_promotion', billingAction: 'percentage_discount', billingValue: 50 },
      { status: 'bonus_promotion', billingAction: null, billingValue: null },
      { status: 'pay_regular', billingAction: null, billingValue: null },
    ]);
  });

  it('never applies a disabled Membership Fee Benefit', () => {
    const { periods } = computePromotionTimeline(
      {
        freeMonths: 0, paidMonths: 2, payBeforehandMonths: 0, bonusMonths: 0,
        membershipFeeAction: 'fixed_price', membershipFeeValue: 10, membershipFeeEnabled: false,
      },
      '2026-01-01',
    );
    expect(periods.every((p) => p.billingAction === null)).toBe(true);
  });

  it('never applies a "no_benefit" action even when enabled', () => {
    const { periods } = computePromotionTimeline(
      {
        freeMonths: 0, paidMonths: 2, payBeforehandMonths: 0, bonusMonths: 0,
        membershipFeeAction: 'no_benefit', membershipFeeValue: null, membershipFeeEnabled: true,
      },
      '2026-01-01',
    );
    expect(periods.every((p) => p.billingAction === null)).toBe(true);
  });

  it('stops applying the Membership Fee Benefit once durationMonths elapses from the anchor', () => {
    const { periods } = computePromotionTimeline(
      {
        freeMonths: 0, paidMonths: 3, payBeforehandMonths: 0, bonusMonths: 0,
        membershipFeeAction: 'waive', membershipFeeValue: null, membershipFeeEnabled: true,
        membershipFeeDurationMonths: 2,
      },
      '2026-01-01',
    );
    // 3 pay_promotion periods (Jan, Feb, Mar) — the benefit only covers the
    // first 2 months from the anchor (Jan, Feb); March is regular billing.
    expect(periods.map((p) => p.billingAction)).toEqual(['waive', 'waive', null, null]);
  });

  // #625: the Membership Fee Benefit belongs to the Promotion and can never be
  // applied to the Pay (regular) period, even if its configured duration
  // exceeds the Promotion duration or is unbounded.
  it('never applies the Membership Fee Benefit to pay_regular when duration exceeds the promotion (ticket forecast example)', () => {
    // Free 1, Paid 2 (Pay Beforehand 2 → both prepaid), Bonus 2 → duration 5.
    // Membership Fee configured for 7 months must not reach period 6+ (regular).
    const { periods } = computePromotionTimeline(
      {
        freeMonths: 1, paidMonths: 2, payBeforehandMonths: 2, bonusMonths: 2,
        membershipFeeAction: 'fixed_price', membershipFeeValue: 100, membershipFeeEnabled: true,
        membershipFeeDurationMonths: 7,
      },
      '2026-01-01',
    );
    expect(periods.map((p) => [p.status, p.billingAction])).toEqual([
      ['free_promotion', null],
      ['prepaid_promotion', 'fixed_price'],
      ['prepaid_promotion', 'fixed_price'],
      ['bonus_promotion', null],
      ['bonus_promotion', null],
      ['pay_regular', null],
    ]);
    // The €100 Fixed Price must not appear in the regular period.
    expect(periods.find((p) => p.status === 'pay_regular')?.billingValue).toBeNull();
  });

  it('never applies an unbounded (null-duration) Membership Fee Benefit to pay_regular', () => {
    const { periods } = computePromotionTimeline(
      {
        freeMonths: 0, paidMonths: 1, payBeforehandMonths: 0, bonusMonths: 0,
        membershipFeeAction: 'waive', membershipFeeValue: null, membershipFeeEnabled: true,
        membershipFeeDurationMonths: null,
      },
      '2026-01-01',
    );
    expect(periods.map((p) => [p.status, p.billingAction])).toEqual([
      ['pay_promotion', 'waive'],
      ['pay_regular', null],
    ]);
  });
});
