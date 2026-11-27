import { describe, expect, it } from 'vitest';
import { gatewayRegistrationRequired, resolveDefaultPaymentMethod } from '../domain/paymentGatewayRegistration';

describe('gateway registration rule (#3512)', () => {
  it('reads a missing preference as Automated (#3497 default)', () => {
    expect(resolveDefaultPaymentMethod(null)).toBe('automated');
    expect(resolveDefaultPaymentMethod('  ')).toBe('automated');
    expect(resolveDefaultPaymentMethod('cash')).toBe('cash');
  });

  it('warns only an Automated payer with no MONEI token', () => {
    const base = { defaultPaymentMethod: 'automated', hasMoneiToken: false, paysForSelf: true };
    expect(gatewayRegistrationRequired(base)).toBe(true);
    expect(gatewayRegistrationRequired({ ...base, hasMoneiToken: true })).toBe(false);
    expect(gatewayRegistrationRequired({ ...base, defaultPaymentMethod: 'cash' })).toBe(false);
    expect(gatewayRegistrationRequired({ ...base, paysForSelf: false })).toBe(false);
  });
});
