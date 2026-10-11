// #1459: which payment actions a Billing Event offers, and the manual method vocabulary.
import { describe, expect, it } from 'vitest';
import { paymentActionsFor } from '../domain/billingEventStatus';
import { parseManualPaymentMethod, ATTEMPT_METHODS } from '../domain/paymentAttemptMethod';

const base = {
  status: 'failed' as const, eventType: 'failed_billing', scheduledAndDue: false, linked: true,
  membershipStatus: 'active', hasMembership: true, amount: 40,
};

describe('paymentActionsFor', () => {
  it('offers every settlement action on a failed event, via the event route', () => {
    expect(paymentActionsFor(base)).toEqual({ retry: true, waive: true, payCash: true, payCard: true, firstPayment: false });
  });

  it('offers a due, uncollected scheduled obligation the same actions', () => {
    const a = paymentActionsFor({ ...base, status: 'scheduled' as any, eventType: 'charge_created', scheduledAndDue: true });
    expect(a.retry && a.waive && a.payCash && a.payCard).toBe(true);
  });

  it('offers cash and card (only) on a first payment awaiting payment, through record-payment', () => {
    const a = paymentActionsFor({ ...base, status: 'pending', eventType: 'payment_recorded', membershipStatus: 'pending_payment' });
    expect(a).toEqual({ retry: false, waive: false, payCash: true, payCard: true, firstPayment: true });
  });

  it('offers nothing on a paid, pending-online or waived event', () => {
    for (const status of ['paid', 'pending', 'recorded'] as const) {
      const a = paymentActionsFor({ ...base, status, eventType: 'recurring_payment' });
      expect(a).toEqual({ retry: false, waive: false, payCash: false, payCard: false, firstPayment: false });
    }
  });

  it('offers nothing without an amount, a link or on a one-off purchase', () => {
    expect(paymentActionsFor({ ...base, amount: 0 }).payCash).toBe(false);
    expect(paymentActionsFor({ ...base, linked: false }).payCash).toBe(false);
    expect(paymentActionsFor({ ...base, eventType: 'product_purchase' }).payCash).toBe(false);
  });
});

describe('manual payment method', () => {
  it('defaults to cash and accepts card_terminal only beside it', () => {
    expect(parseManualPaymentMethod(undefined)).toBe('cash');
    expect(parseManualPaymentMethod('card_terminal')).toBe('card_terminal');
    expect(parseManualPaymentMethod('provider')).toBeNull();
    expect(parseManualPaymentMethod('waive')).toBeNull();
    expect(ATTEMPT_METHODS).toContain('card_terminal');
  });
});
