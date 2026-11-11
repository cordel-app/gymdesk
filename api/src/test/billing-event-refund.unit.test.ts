// #2480: the pure refund rules (`domain/billingEventRefund.ts`) and the
// cancelled status (`domain/billingEventStatus.ts`).
import { describe, expect, it } from 'vitest';
import {
  decideRefund, refundBalance, refundMethodsFor, refundOutcomeFromProvider, refundState,
} from '../domain/billingEventRefund';
import { canCancelBillingEvent, deriveBillingEventStatus, isAwaitingAction } from '../domain/billingEventStatus';

const lines = [{ id: 1, amount: '30.00', refundedCents: 0 }, { id: 2, amount: '10.00', refundedCents: 1000 }];

describe('refund balance', () => {
  it('reserves pending refunds and ignores failed ones', () => {
    const b = refundBalance(4000, [
      { amount: '10.00', status: 'completed' }, { amount: '5.00', status: 'pending' }, { amount: '20.00', status: 'failed' },
    ]);
    expect(b).toEqual({ collectedCents: 4000, refundedCents: 1500, refundableCents: 2500 });
  });

  it('names the refund state from completed refunds only', () => {
    expect(refundState(4000, 0)).toBe('none');
    expect(refundState(4000, 1000)).toBe('partial');
    expect(refundState(4000, 4000)).toBe('full');
  });
});

describe('decideRefund', () => {
  const balance = refundBalance(4000, [{ amount: '10.00', status: 'completed' }]);
  const all = ['cash', 'card_terminal', 'provider'] as const;

  it('full refunds what remains', () => {
    expect(decideRefund({ kind: 'full', method: 'cash' }, balance, lines, all)).toMatchObject({ ok: true, refund: { amountCents: 3000 } });
  });

  it('refuses an unknown kind or method, or a method the payment cannot use', () => {
    expect(decideRefund({ kind: 'x', method: 'cash' }, balance, lines, all).ok).toBe(false);
    expect(decideRefund({ kind: 'full', method: 'bizum' }, balance, lines, all).ok).toBe(false);
    expect(decideRefund({ kind: 'full', method: 'provider' }, balance, lines, ['cash']).ok).toBe(false);
  });

  it('validates an ad-hoc amount', () => {
    for (const amount of [0, '0.00', '-1', '1.001', '', 'x', '30.01', '41']) {
      expect(decideRefund({ kind: 'adhoc', method: 'cash', amount }, balance, lines, all).ok).toBe(false);
    }
    expect(decideRefund({ kind: 'adhoc', method: 'cash', amount: 29.99 }, balance, lines, all))
      .toMatchObject({ ok: true, refund: { amountCents: 2999 } });
  });

  it('selects lines by what each has left, never twice', () => {
    expect(decideRefund({ kind: 'lines', method: 'cash', line_ids: [1] }, balance, lines, all))
      .toMatchObject({ ok: true, refund: { amountCents: 3000, lines: [{ id: 1, cents: 3000 }] } });
    expect(decideRefund({ kind: 'lines', method: 'cash', line_ids: [2] }, balance, lines, all).ok).toBe(false);
    expect(decideRefund({ kind: 'lines', method: 'cash', line_ids: [9] }, balance, lines, all).ok).toBe(false);
    expect(decideRefund({ kind: 'lines', method: 'cash', line_ids: [1] }, refundBalance(4000, [{ amount: '15', status: 'pending' }]), lines, all).ok).toBe(false);
  });

  it('refuses everything once nothing is refundable', () => {
    expect(decideRefund({ kind: 'full', method: 'cash' }, refundBalance(4000, [{ amount: '40', status: 'completed' }]), lines, all).ok).toBe(false);
  });
});

describe('refund methods and provider outcome', () => {
  it('offers the provider only for a provider payment with a reference', () => {
    expect(refundMethodsFor({ method: 'provider', providerRef: 'p' })).toEqual(['provider', 'cash', 'card_terminal']);
    expect(refundMethodsFor({ method: 'provider', providerRef: null })).toEqual(['cash', 'card_terminal']);
    expect(refundMethodsFor({ method: 'cash', providerRef: null })).toEqual(['cash', 'card_terminal']);
  });

  it('counts only REFUNDED / PARTIALLY_REFUNDED as completed', () => {
    expect(refundOutcomeFromProvider('REFUNDED')).toBe('completed');
    expect(refundOutcomeFromProvider('PARTIALLY_REFUNDED')).toBe('completed');
    expect(refundOutcomeFromProvider('PENDING')).toBe('pending');
    expect(refundOutcomeFromProvider('SUCCEEDED')).toBe('failed');
    expect(refundOutcomeFromProvider(null)).toBe('failed');
  });
});

describe('cancelled status', () => {
  it('reads cancelled unless money arrived, and is never awaiting action', () => {
    expect(deriveBillingEventStatus('payment_recorded', 'expired', true)).toBe('cancelled');
    expect(deriveBillingEventStatus('payment_recorded', 'completed', true)).toBe('paid');
    expect(isAwaitingAction('failed_billing', 'expired', true)).toBe(false);
    expect(canCancelBillingEvent('pending')).toBe(true);
    for (const s of ['paid', 'failed', 'scheduled', 'recorded', 'cancelled'] as const) expect(canCancelBillingEvent(s)).toBe(false);
  });
});
