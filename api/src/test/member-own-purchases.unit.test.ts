// #1862 — which purchased Products a member is shown (the owner's rule).
import { describe, expect, it } from 'vitest';
import { ownPurchaseEndDate, ownPurchaseState } from '../domain/memberOwnPurchases';

const TODAY = '2026-10-20';
const row = (over: Partial<{ status: string; valid_until: string | null; cancelled_on: string | null }>) => ({
  status: 'active', valid_until: null, cancelled_on: null, ...over,
});

describe('ownPurchaseState', () => {
  it('shows an Active purchase whatever its end date', () => {
    expect(ownPurchaseState(row({ valid_until: '2020-01-01' }), TODAY)).toBe('active');
    expect(ownPurchaseState(row({}), TODAY)).toBe('active');
  });

  it('shows a purchase awaiting payment so the member can pay it', () => {
    expect(ownPurchaseState(row({ status: 'pending_payment' }), TODAY)).toBe('pending_payment');
  });

  it('shows a Cancelled purchase only while its end date is strictly later than today', () => {
    expect(ownPurchaseState(row({ cancelled_on: '2026-10-10', valid_until: '2026-10-21' }), TODAY)).toBe('cancelled');
    expect(ownPurchaseState(row({ cancelled_on: '2026-10-10', valid_until: TODAY }), TODAY)).toBeNull();
    expect(ownPurchaseState(row({ cancelled_on: '2026-10-10', valid_until: '2026-10-01' }), TODAY)).toBeNull();
  });

  it('ends a Cancelled purchase with no defined validity on the day it was cancelled', () => {
    expect(ownPurchaseState(row({ cancelled_on: TODAY }), TODAY)).toBeNull();
    expect(ownPurchaseState(row({ cancelled_on: '2026-10-25' }), TODAY)).toBe('cancelled');
  });

  it('hides drafts and failed payments', () => {
    expect(ownPurchaseState(row({ status: 'draft' }), TODAY)).toBeNull();
    expect(ownPurchaseState(row({ status: 'cancelled' }), TODAY)).toBeNull();
  });
});

describe('ownPurchaseEndDate', () => {
  it('is the last valid day, else the cancellation day, else none', () => {
    expect(ownPurchaseEndDate(row({ valid_until: '2026-11-01' }))).toBe('2026-11-01');
    expect(ownPurchaseEndDate(row({ cancelled_on: '2026-10-10' }))).toBe('2026-10-10');
    expect(ownPurchaseEndDate(row({}))).toBeNull();
  });
});
