import { describe, it, expect } from 'vitest';
import { paymentMethodCodeFor } from '../domain/paymentAttemptSnapshot';

describe('paymentMethodCodeFor (#2451)', () => {
  it('maps manual methods to the catalogue', () => {
    expect(paymentMethodCodeFor('cash', 'manual')).toBe('cash');
    expect(paymentMethodCodeFor('card_terminal', 'manual')).toBe('card');
  });
  it('maps online attempts to Monei, or Members App when the member raised it', () => {
    expect(paymentMethodCodeFor('provider', 'admin')).toBe('monei');
    expect(paymentMethodCodeFor('provider', 'billing_run')).toBe('monei');
    expect(paymentMethodCodeFor('provider', 'customer')).toBe('members_app');
    expect(paymentMethodCodeFor('provider', 'product_purchase')).toBe('members_app');
  });
  it('snapshots nothing for a waiver or an unknown method', () => {
    expect(paymentMethodCodeFor('waive', 'billing_run')).toBeNull();
    expect(paymentMethodCodeFor(null, null)).toBeNull();
  });
});
