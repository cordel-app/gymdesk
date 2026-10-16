import { describe, expect, it } from 'vitest';
import { methodAvailability, payFlowFor } from '../domain/productSetPayment';

describe('productSetPayment (#1664)', () => {
  it('maps the four supported codes and nothing else', () => {
    expect(payFlowFor('cash')).toEqual({ flow: 'manual', attemptMethod: 'cash' });
    expect(payFlowFor('card')).toEqual({ flow: 'manual', attemptMethod: 'card_terminal' });
    expect(payFlowFor('monei')?.flow).toBe('monei');
    expect(payFlowFor('members_app')?.flow).toBe('members_app');
    for (const c of ['google_pay', 'apple_pay', 'paypal', 'bizum', 'toString', '', null]) expect(payFlowFor(c)).toBeNull();
  });
  it('monei needs a token; unsupported codes are never available', () => {
    expect(methodAvailability('monei', { hasMoneiToken: false })).toEqual({ available: false, reason: 'monei_token_missing' });
    expect(methodAvailability('monei', { hasMoneiToken: true }).available).toBe(true);
    expect(methodAvailability('bizum', { hasMoneiToken: true })).toEqual({ available: false, reason: 'unsupported' });
  });
});
