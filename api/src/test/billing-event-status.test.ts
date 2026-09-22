// Unit tests for the Billing Event status derivation (#640) — pure functions,
// no DB and no HTTP, so no test gym/helpers here.

import { describe, expect, it } from 'vitest';
import {
  deriveBillingEventStatus,
  isPaymentActionable,
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

  it('falls back to recorded for informational events', () => {
    expect(statusFromEventType('adjustment')).toBe('recorded');
    expect(statusFromEventType('status_changed')).toBe('recorded');
    expect(statusFromEventType('charge_created')).toBe('recorded');
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
    expect(deriveBillingEventStatus('adjustment', null)).toBe('recorded');
  });
});

describe('isPaymentActionable', () => {
  it('offers the payment actions only for a failed event', () => {
    expect(isPaymentActionable('failed')).toBe(true);
    expect(isPaymentActionable('paid')).toBe(false);
    expect(isPaymentActionable('pending')).toBe(false);
    expect(isPaymentActionable('scheduled')).toBe(false);
    expect(isPaymentActionable('recorded')).toBe(false);
  });
});
