import { describe, expect, it } from 'vitest';
import {
  adhocAmountError, canAcceptRefund, refundAmount, refundMethodHelpKey, refundRequestBody, selectedLinesTotal, type RefundOptions,
} from '../app/[locale]/payments/billing-events/refundForm';

// #2480: the Refund modal's arithmetic. The server re-judges every request;
// this only keeps the confirmation honest about what it will send.
const opts: RefundOptions = {
  billing_event_id: 1, collected_amount: '40.00', refunded_amount: '10.00', refundable_amount: '30.00', refund_state: 'partial',
  method: { code: 'cash', name: 'Cash', manual: true },
  lines: [
    { id: 1, kind: 'product', item_name: 'A', quantity: 1, amount: '20.10', refunded_amount: '0.00', refundable_amount: '20.10' },
    { id: 2, kind: 'product', item_name: 'B', quantity: 1, amount: '9.90', refunded_amount: '0.00', refundable_amount: '9.90' },
    { id: 3, kind: 'product', item_name: 'C', quantity: 1, amount: '10.00', refunded_amount: '10.00', refundable_amount: '0.00' },
  ],
};

describe('refundForm', () => {
  it('sums the selected lines exactly and ignores refunded ones', () => {
    expect(selectedLinesTotal(opts.lines, new Set([1, 2]))).toBe('30.00');
    expect(selectedLinesTotal(opts.lines, new Set([3]))).toBe('0.00');
  });

  it('validates an ad-hoc amount against the refundable balance', () => {
    expect(adhocAmountError('abc', opts)).toBe('invalid');
    expect(adhocAmountError('1.234', opts)).toBe('invalid');
    expect(adhocAmountError('0', opts)).toBe('zero');
    expect(adhocAmountError('30.01', opts)).toBe('exceeds');
    expect(adhocAmountError('12,50', opts)).toBeNull();
  });

  it('computes the final amount per kind and gates Accept', () => {
    expect(refundAmount('full', opts, new Set(), '')).toBe('30.00');
    expect(refundAmount('lines', opts, new Set(), '')).toBeNull();
    expect(refundAmount('adhoc', opts, new Set(), '5')).toBe('5.00');
    expect(canAcceptRefund('full', opts, new Set(), '', false)).toBe(true);
    expect(canAcceptRefund('full', opts, new Set(), '', true)).toBe(false);
  });

  it('picks the help line from the original method', () => {
    expect(refundMethodHelpKey({ code: 'cash', name: 'Cash', manual: true })).toBe('refund_method_manual_help');
    expect(refundMethodHelpKey({ code: 'card_terminal', name: 'Card', manual: true })).toBe('refund_method_manual_help');
    expect(refundMethodHelpKey({ code: 'provider', name: 'Monei', manual: false })).toBe('refund_method_provider_help');
  });

  it('builds the request body', () => {
    // #2797: the body never names a payment method; the server uses the original one.
    expect(refundRequestBody('lines', new Set([2]), '')).toEqual({ kind: 'lines', line_ids: [2] });
    expect(refundRequestBody('adhoc', new Set(), '3,5')).toEqual({ kind: 'adhoc', amount: '3.5' });
    expect(refundRequestBody('full', new Set(), '')).toEqual({ kind: 'full' });
  });
});
