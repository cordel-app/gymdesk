import { describe, expect, it } from 'vitest';
import { computeValidUntil, endDateOnCancel, purchaseValidityState } from '../domain/productValidity';

describe('computeValidUntil (#1693)', () => {
  it('monthly: Oct 1 → Oct 31, mid-month rolls to the day before', () => {
    expect(computeValidUntil({ purchasedOn: '2026-10-01', validityDays: null, billingFrequency: 'month' })).toBe('2026-10-31');
    expect(computeValidUntil({ purchasedOn: '2026-10-15', validityDays: null, billingFrequency: 'month' })).toBe('2026-11-14');
  });
  it('month boundaries and leap years', () => {
    expect(computeValidUntil({ purchasedOn: '2028-02-01', validityDays: null, billingFrequency: 'month' })).toBe('2028-02-29');
    expect(computeValidUntil({ purchasedOn: '2027-02-01', validityDays: null, billingFrequency: 'month' })).toBe('2027-02-28');
    expect(computeValidUntil({ purchasedOn: '2026-01-31', validityDays: null, billingFrequency: 'month' })).toBe('2026-02-27');
    expect(computeValidUntil({ purchasedOn: '2028-02-29', validityDays: null, billingFrequency: 'year' })).toBe('2029-02-27');
  });
  it('explicit validity_days wins and counts the purchase day', () => {
    expect(computeValidUntil({ purchasedOn: '2026-10-01', validityDays: 30, billingFrequency: 'month' })).toBe('2026-10-30');
  });
  it('no defined validity → null', () => {
    expect(computeValidUntil({ purchasedOn: '2026-10-01', validityDays: null, billingFrequency: 'once' })).toBeNull();
    expect(computeValidUntil({ purchasedOn: '2026-10-01', validityDays: null, billingFrequency: null })).toBeNull();
  });
});

describe('cancellation vs expiry (#1693)', () => {
  it('cancelling keeps the paid end date; without one it ends today', () => {
    expect(endDateOnCancel('2026-10-31', '2026-10-04')).toBe('2026-10-31');
    expect(endDateOnCancel(null, '2026-10-04')).toBe('2026-10-04');
  });
  it('cancelled is still valid through the end date inclusive, expired after', () => {
    const row = { status: 'active', valid_until: '2026-10-31', cancelled_on: '2026-10-04' };
    expect(purchaseValidityState(row, '2026-10-04')).toBe('cancelled');
    expect(purchaseValidityState(row, '2026-10-31')).toBe('cancelled');
    expect(purchaseValidityState(row, '2026-11-01')).toBe('expired');
  });
  it('pending and failed payments are not purchases', () => {
    expect(purchaseValidityState({ status: 'pending_payment', valid_until: null, cancelled_on: null }, '2026-10-04')).toBe('pending');
    expect(purchaseValidityState({ status: 'cancelled', valid_until: null, cancelled_on: null }, '2026-10-04')).toBe('failed');
  });
  it('a saved draft (#1657 stage 2) is a draft, not a failed payment', () => {
    expect(purchaseValidityState({ status: 'draft', valid_until: null, cancelled_on: null }, '2026-10-04')).toBe('draft');
  });
});
