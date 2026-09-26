import { describe, expect, it } from 'vitest';
import { isReceiptableEvent, receiptRefusalReason } from '../domain/billingEventStatus';

/**
 * #787: the predicate that decides which Billing Events may carry a receipt.
 *
 * Pure, so no DB and no helpers. The point of these cases is that the rule is
 * "money actually received" and nothing else — in particular that a settled
 * `failed_billing` qualifies without a special case, which is the one thing
 * the ticket asked to confirm rather than specify.
 */
describe('isReceiptableEvent', () => {
  describe('money received', () => {
    it('accepts a cash payment_recorded with no transaction at all', () => {
      // The front desk's cash payment writes the ledger row and nothing else,
      // so the event type is the only thing that can answer. Receipt-able
      // since #114 — this is the case #787 must not regress.
      expect(isReceiptableEvent('payment_recorded', null)).toBe(true);
    });

    it('accepts a payment_recorded whose checkout completed', () => {
      expect(isReceiptableEvent('payment_recorded', 'completed')).toBe(true);
    });

    it('accepts a recurring_payment settled by the nightly run', () => {
      expect(isReceiptableEvent('recurring_payment', 'completed')).toBe(true);
    });

    it('accepts a failed_billing later settled by Retry or Manual payment', () => {
      // #640's two actions never append a second Billing Event: the money is
      // recorded as a completed transaction against the rejected row, so that
      // row is the only thing there is to issue a receipt against.
      expect(isReceiptableEvent('failed_billing', 'completed')).toBe(true);
    });
  });

  describe('no money received', () => {
    it('refuses a recurring_payment the provider rejected', () => {
      expect(isReceiptableEvent('recurring_payment', 'failed')).toBe(false);
    });

    it('refuses a recurring_payment whose transaction expired', () => {
      expect(isReceiptableEvent('recurring_payment', 'expired')).toBe(false);
    });

    it('refuses a payment still pending', () => {
      expect(isReceiptableEvent('recurring_payment', 'pending')).toBe(false);
      expect(isReceiptableEvent('payment_recorded', 'pending')).toBe(false);
    });

    it('refuses a failed_billing that is still failed', () => {
      expect(isReceiptableEvent('failed_billing', null)).toBe(false);
      expect(isReceiptableEvent('failed_billing', 'failed')).toBe(false);
    });

    it('refuses a waived cycle', () => {
      // A waived cycle calls no provider and writes no transaction — there is
      // no payment to receipt, only a ledger note that none was due.
      expect(isReceiptableEvent('waived_billing', null)).toBe(false);
      // Even a stray transaction would not make it one.
      expect(isReceiptableEvent('waived_billing', 'completed')).toBe(false);
    });

    it('refuses an adjustment, a charge_created and a status_changed', () => {
      expect(isReceiptableEvent('adjustment', null)).toBe(false);
      expect(isReceiptableEvent('adjustment', 'completed')).toBe(false);
      expect(isReceiptableEvent('charge_created', null)).toBe(false);
      expect(isReceiptableEvent('status_changed', null)).toBe(false);
    });

    it('refuses an event type it has never heard of', () => {
      expect(isReceiptableEvent('something_new', 'completed')).toBe(false);
    });
  });
});

describe('receiptRefusalReason', () => {
  it('returns null for every receipt-able shape', () => {
    expect(receiptRefusalReason('payment_recorded', null)).toBeNull();
    expect(receiptRefusalReason('recurring_payment', 'completed')).toBeNull();
    expect(receiptRefusalReason('failed_billing', 'completed')).toBeNull();
  });

  it('names the event type when the type itself records no payment', () => {
    const reason = receiptRefusalReason('waived_billing', null);
    expect(reason).toContain('waived_billing');
  });

  it('names the payment status when the type could have been paid but was not', () => {
    // The distinction matters to the person reading the 400: "this can never
    // have a receipt" and "this one has not been paid" are different problems.
    expect(receiptRefusalReason('recurring_payment', 'failed')).toContain("'failed'");
    expect(receiptRefusalReason('recurring_payment', 'pending')).toContain("'pending'");
  });

  it('never disagrees with the predicate', () => {
    const types = ['payment_recorded', 'recurring_payment', 'failed_billing',
      'waived_billing', 'adjustment', 'charge_created', 'status_changed'];
    const statuses = [null, 'completed', 'failed', 'expired', 'pending'];
    for (const type of types) {
      for (const status of statuses) {
        expect(receiptRefusalReason(type, status) === null)
          .toBe(isReceiptableEvent(type, status));
      }
    }
  });
});
