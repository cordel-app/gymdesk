import { describe, expect, it } from 'vitest';
import {
  MembershipFeeRow,
  assignmentPlanDuration,
  nextPricingDate,
} from '../api/membership-fee-pricing';

/**
 * #635 stage 15 — the two pure decisions the fee resolver makes before it prices
 * anything: *which cycle* "what does this cost now" means, and *whose* Billing &
 * Duration applies. Both used to be copied into every query that needed them;
 * neither touches the database, so both are pinned here rather than through a
 * gym fixture.
 */

const row = (over: Partial<MembershipFeeRow> = {}): MembershipFeeRow => ({
  id: 1,
  starts_at: '2026-01-10',
  membership_plan_id: 7,
  membership_fee_price: 50,
  base_price: 0,
  free_months: null,
  paid_months: null,
  bonus_months: null,
  pay_beforehand_months: null,
  plan_free_months: null,
  plan_paid_months: null,
  plan_bonus_months: null,
  plan_pay_beforehand_months: null,
  has_billing_snapshot: 1,
  ...over,
});

describe('nextPricingDate', () => {
  const today = '2026-06-15';

  it('prices the next billing cycle when it is still ahead', () => {
    expect(nextPricingDate(row({ next_billing_date: '2026-07-01' }), today)).toBe('2026-07-01');
  });

  it('never prices a cycle already past — a missed run must not reprice history', () => {
    expect(nextPricingDate(row({ next_billing_date: '2026-05-01' }), today)).toBe(today);
  });

  it('never prices before the contract begins', () => {
    expect(nextPricingDate(row({ starts_at: '2026-09-01', next_billing_date: null }), today))
      .toBe('2026-09-01');
  });

  it('falls back to the start date when no cycle is scheduled', () => {
    expect(nextPricingDate(row({ starts_at: '2026-01-10', next_billing_date: null }), today))
      .toBe(today);
  });

  it('accepts a Date, as mysql2 may return one for a DATE column', () => {
    expect(nextPricingDate(row({ next_billing_date: new Date('2026-07-01T00:00:00Z') }), today))
      .toBe('2026-07-01');
  });
});

describe('assignmentPlanDuration', () => {
  it('reads the assignment\'s own months once it has captured a snapshot', () => {
    expect(assignmentPlanDuration(row({
      has_billing_snapshot: 1,
      free_months: 1, paid_months: 12, bonus_months: 2, pay_beforehand_months: 3,
      plan_free_months: 6, plan_paid_months: 6, plan_bonus_months: 6, plan_pay_beforehand_months: 6,
    }))).toEqual({ freeMonths: 1, paidMonths: 12, bonusMonths: 2, prepaidMonths: 3 });
  });

  // All-or-nothing (§13): a captured assignment reads its own columns *including*
  // the NULL ones, so a Free Period added to the Plan later cannot reach it.
  it('reads its own NULLs as zero rather than falling back per column', () => {
    expect(assignmentPlanDuration(row({
      has_billing_snapshot: 1,
      free_months: null, paid_months: 12, bonus_months: null, pay_beforehand_months: null,
      plan_free_months: 6, plan_bonus_months: 6,
    }))).toEqual({ freeMonths: 0, paidMonths: 12, bonusMonths: 0, prepaidMonths: 0 });
  });

  it('follows the Plan only for an assignment that captured nothing at all', () => {
    expect(assignmentPlanDuration(row({
      has_billing_snapshot: 0,
      plan_free_months: 1, plan_paid_months: 12, plan_bonus_months: 2, plan_pay_beforehand_months: 1,
    }))).toEqual({ freeMonths: 1, paidMonths: 12, bonusMonths: 2, prepaidMonths: 1 });
  });

  it('clamps a Pre-paid Duration to the Paid Duration it is a slice of', () => {
    expect(assignmentPlanDuration(row({
      has_billing_snapshot: 1, paid_months: 3, pay_beforehand_months: 9,
    }))).toMatchObject({ paidMonths: 3, prepaidMonths: 3 });
  });
});
