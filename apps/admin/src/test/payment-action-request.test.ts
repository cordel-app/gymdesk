import { describe, expect, it } from 'vitest';
import { actionRequest, canAccept } from '../app/[locale]/payments/billing-events/paymentActions';

// #1459: what Accept sends — never an amount, never an online provider.
describe('actionRequest', () => {
  const row = { id: 7, user_membership_id: 42 };

  it('settles a failed/due event through the manual-payment route with the method', () => {
    expect(actionRequest('cash', row)).toEqual({ path: '/payments/billing-events/7/manual-payment', body: { method: 'cash' } });
    expect(actionRequest('card', row)).toEqual({ path: '/payments/billing-events/7/manual-payment', body: { method: 'card_terminal' } });
  });

  it('routes a first payment through the membership record-payment', () => {
    expect(actionRequest('card', { ...row, first_payment: true })).toEqual({
      path: '/user-memberships/42/record-payment', body: { method: 'card_terminal' },
    });
  });

  it('sends the trimmed reason for a waiver', () => {
    expect(actionRequest('waive', row, { reason: '  goodwill ' })).toEqual({
      path: '/payments/billing-events/7/waive', body: { reason: 'goodwill' },
    });
  });

  it('never sends an amount', () => {
    for (const k of ['cash', 'card', 'waive'] as const) {
      expect(Object.keys(actionRequest(k, row, { reason: 'x' }).body)).not.toContain('amount');
    }
  });
});

describe('canAccept', () => {
  it('blocks while busy and requires a reason only for a waiver', () => {
    expect(canAccept('cash', '', false)).toBe(true);
    expect(canAccept('card', '', true)).toBe(false);
    expect(canAccept('waive', '  ', false)).toBe(false);
    expect(canAccept('waive', 'x', false)).toBe(true);
  });
});
