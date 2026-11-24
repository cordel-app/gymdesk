// Unit tests for the Billing Event status derivation (#640) — pure functions,
// no DB and no HTTP, so no test gym/helpers here.

import { describe, expect, it } from 'vitest';
import {
  deriveBillingEventStatus,
  isAwaitingAction,
  isPaymentActionable,
  isPaymentCollected,
  statusFromEventType,
  statusFromTransaction,
} from '../domain/billingEventStatus';

describe('statusFromTransaction', () => {
  it('maps a completed transaction to paid', () => {
    expect(statusFromTransaction('completed')).toBe('paid');
  });

  it('maps failed and expired alike to failed', () => {
    // An expired hosted-payment request is a charge that was never settled —
    // the same actionable state as an outright rejection.
    expect(statusFromTransaction('failed')).toBe('failed');
    expect(statusFromTransaction('expired')).toBe('failed');
  });

  it('maps pending to pending', () => {
    expect(statusFromTransaction('pending')).toBe('pending');
  });

  it('returns null when there is no transaction', () => {
    expect(statusFromTransaction(null)).toBeNull();
    expect(statusFromTransaction(undefined)).toBeNull();
    expect(statusFromTransaction('something-else')).toBeNull();
  });
});

describe('statusFromEventType', () => {
  it('treats both payment event types as paid', () => {
    expect(statusFromEventType('recurring_payment')).toBe('paid');
    expect(statusFromEventType('payment_recorded')).toBe('paid');
  });

  it('treats failed_billing as failed', () => {
    expect(statusFromEventType('failed_billing')).toBe('failed');
  });

  it('gives an event type that records no payment no status (#3332)', () => {
    expect(statusFromEventType('adjustment')).toBeNull();
    // #3082: a waived one-time purchase has no transaction and is paid.
    expect(statusFromEventType('product_purchase')).toBe('paid');
    expect(statusFromEventType('status_changed')).toBeNull();
    expect(statusFromEventType('card_verification')).toBeNull();
    expect(statusFromEventType('charge_created')).toBeNull();
  });

  it('reads a waiver with no attempt as waived, never paid (#3332)', () => {
    expect(statusFromEventType('waived_billing')).toBe('waived');
    expect(deriveBillingEventStatus('waived_billing', null)).toBe('waived');
    expect(isPaymentCollected('waived_billing', null)).toBe(false);
  });
});

describe('deriveBillingEventStatus', () => {
  it('prefers the latest transaction over the event type', () => {
    // The ledger row stays failed_billing forever (append-only); a successful
    // retry is what makes the event read as paid.
    expect(deriveBillingEventStatus('failed_billing', 'completed')).toBe('paid');
    expect(deriveBillingEventStatus('recurring_payment', 'failed')).toBe('failed');
  });

  it('falls back to the event type when the event has no transactions', () => {
    expect(deriveBillingEventStatus('failed_billing', null)).toBe('failed');
    expect(deriveBillingEventStatus('payment_recorded', null)).toBe('paid');
    expect(deriveBillingEventStatus('adjustment', null)).toBeNull();
  });
});

describe('isPaymentActionable', () => {
  it('offers the payment actions only for a failed event', () => {
    expect(isPaymentActionable('failed')).toBe(true);
    expect(isPaymentActionable('paid')).toBe(false);
    expect(isPaymentActionable('pending')).toBe(false);
    expect(isPaymentActionable('scheduled')).toBe(false);
    expect(isPaymentActionable('waived')).toBe(false);
    expect(isPaymentActionable(null)).toBe(false);
  });
});

// #779: the staff's work queue is exactly the failed filter of the list.
describe('isAwaitingAction', () => {
  it('holds for a failed_billing event with no transaction', () => {
    expect(isAwaitingAction('failed_billing', null)).toBe(true);
  });

  it('holds while the latest transaction is failed or expired', () => {
    expect(isAwaitingAction('recurring_payment', 'failed')).toBe(true);
    expect(isAwaitingAction('charge_created', 'expired')).toBe(true);
  });

  it('clears once a later transaction completed (retry or manual payment)', () => {
    expect(isAwaitingAction('failed_billing', 'completed')).toBe(false);
  });

  it('does not hold for a payment still in flight or an informational row', () => {
    expect(isAwaitingAction('failed_billing', 'pending')).toBe(false);
    expect(isAwaitingAction('status_changed', null)).toBe(false);
    expect(isAwaitingAction('adjustment', null)).toBe(false);
  });
});

// #2480 follow-up: a paid event's displayed status follows its completed refunds.
import { displayBillingEventStatus as display } from '../domain/billingEventStatus';
describe('displayBillingEventStatus', () => {
  it('turns a paid event into partially_refunded / refunded', () => {
    expect(display('paid', 'none')).toBe('paid');
    expect(display('paid', null)).toBe('paid');
    expect(display('paid', 'partial')).toBe('partially_refunded');
    expect(display('paid', 'full')).toBe('refunded');
  });
  it('leaves every other status, cancelled included, as derived', () => {
    for (const s of ['cancelled', 'failed', 'pending', 'scheduled', 'waived'] as const) {
      expect(display(s, 'full')).toBe(s);
    }
  });
});
