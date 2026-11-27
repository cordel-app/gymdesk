// #3497: the vocabulary and write rule of a Member's Default Payment Method.
import { describe, expect, it } from 'vitest';
import {
  chargesAutomatically,
  defaultPaymentMethodChanged,
  offeredDefaultPaymentMethods,
  parseDefaultPaymentMethodInput,
  resolveDefaultPaymentMethod,
} from '../domain/memberDefaultPaymentMethod';

describe('member Default Payment Method (#3497)', () => {
  it('reads no preference as Automated', () => {
    expect(resolveDefaultPaymentMethod(null)).toBe('automated');
    expect(chargesAutomatically(null)).toBe(true);
    expect(chargesAutomatically('cash')).toBe(false);
  });

  it('always offers Automated, the active catalogue methods, and the stored value', () => {
    expect(offeredDefaultPaymentMethods([], null)).toEqual(['automated']);
    expect(offeredDefaultPaymentMethods(['cash', 'card', 'members_app', 'monei'], null))
      .toEqual(['automated', 'members_app', 'cash', 'card']);
    expect(offeredDefaultPaymentMethods(['cash'], 'card')).toEqual(['automated', 'cash', 'card']);
  });

  it('judges a request: null resets, an offered option is accepted, anything else is a 400', () => {
    const offered = ['automated', 'cash'];
    expect(parseDefaultPaymentMethodInput(null, offered)).toEqual({ value: null });
    expect(parseDefaultPaymentMethodInput('automated', offered)).toEqual({ value: 'automated' });
    expect(parseDefaultPaymentMethodInput('cash', offered)).toEqual({ value: 'cash' });
    expect(parseDefaultPaymentMethodInput('card', offered)).toHaveProperty('error');
    expect(parseDefaultPaymentMethodInput('bitcoin', offered)).toHaveProperty('error');
    expect(parseDefaultPaymentMethodInput(1, offered)).toHaveProperty('error');
  });

  it('treats NULL and an explicit Automated as the same method', () => {
    expect(defaultPaymentMethodChanged(null, 'automated')).toBe(false);
    expect(defaultPaymentMethodChanged(null, 'cash')).toBe(true);
  });
});
