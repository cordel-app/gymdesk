// #3312 stage 2 — the one comparison of the shown total with the server's own.
import { describe, expect, it } from 'vitest';
import { amountChangedBody, isStaleAmount, parseExpectedAmountInput, sameAmount } from '../domain/expectedCheckoutAmount';
import { checkoutRequestBody, setCommitErrorKey } from '../../../apps/member/src/lib/memberProducts';
import { cartErrorKey } from '../../../apps/member/src/lib/memberCart';

describe('parseExpectedAmountInput', () => {
  it('treats an absent value as no expectation and accepts a number or numeric string', () => {
    expect(parseExpectedAmountInput(undefined)).toEqual({ ok: true, value: null });
    expect(parseExpectedAmountInput(null)).toEqual({ ok: true, value: null });
    expect(parseExpectedAmountInput(12.5)).toEqual({ ok: true, value: 12.5 });
    expect(parseExpectedAmountInput('12.50')).toEqual({ ok: true, value: 12.5 });
    expect(parseExpectedAmountInput(0)).toEqual({ ok: true, value: 0 });
  });
  it('refuses anything else', () => {
    for (const bad of ['ten', '', -1, Number.NaN, Infinity, {}, [], true]) {
      expect(parseExpectedAmountInput(bad).ok).toBe(false);
    }
  });
});

describe('stale amount', () => {
  it('compares in cents', () => {
    expect(sameAmount(10.1, 10.10)).toBe(true);
    expect(sameAmount(0.1 + 0.2, 0.3)).toBe(true);
    expect(sameAmount(10, 10.01)).toBe(false);
  });
  it('is stale only when an expectation was sent and differs', () => {
    expect(isStaleAmount(null, 99)).toBe(false);
    expect(isStaleAmount(42.5, 42.5)).toBe(false);
    expect(isStaleAmount(42.5, 52.5)).toBe(true);
    expect(isStaleAmount(10, 0)).toBe(true);
  });
  it('answers the current amount with the code the Members App recognises', () => {
    expect(amountChangedBody(52.499999)).toMatchObject({ error: 'amount_changed', amount: 52.5 });
  });
});

describe('Members App', () => {
  it('sends the shown amount, or nothing when none was shown', () => {
    expect(JSON.parse(checkoutRequestBody(42.5))).toEqual({ expected_amount: 42.5 });
    expect(JSON.parse(checkoutRequestBody(null))).toEqual({});
    expect(JSON.parse(checkoutRequestBody(undefined))).toEqual({});
  });
  it('explains the refusal with the same key on both checkouts', () => {
    expect(setCommitErrorKey('amount_changed')).toBe('membership.cart_error_amount_changed');
    expect(cartErrorKey('amount_changed')).toBe('membership.cart_error_amount_changed');
  });
});
