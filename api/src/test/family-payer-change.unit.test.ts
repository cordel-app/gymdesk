import { describe, expect, it } from 'vitest';
import { payerChangeBlock } from '../domain/familyPayerChange';

const base = { memberId: 1, newPayerMemberId: 2, hasObligations: true, paymentInFlight: false, newPayerHasCard: true };

describe('payerChangeBlock', () => {
  it('allows a change where every new payer can be charged', () => {
    expect(payerChangeBlock([base])).toBeNull();
  });
  it('allows a card-less new payer when nothing is owed', () => {
    expect(payerChangeBlock([{ ...base, hasObligations: false, newPayerHasCard: false }])).toBeNull();
  });
  it('refuses a card-less new payer for a member with obligations', () => {
    expect(payerChangeBlock([base, { ...base, memberId: 3, newPayerHasCard: false }]))
      .toEqual({ code: 'payer_without_card', memberIds: [3] });
  });
  it('refuses while a payment is in flight, ahead of the card check', () => {
    expect(payerChangeBlock([{ ...base, paymentInFlight: true, newPayerHasCard: false }]))
      .toEqual({ code: 'payment_in_flight', memberIds: [1] });
  });
});
