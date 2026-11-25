// #3284 — the Initial Payment's Benefit / discount cell words every treatment the server classified.
import { describe, expect, it } from 'vitest';
import { discountEntries, initialPaymentLineAction } from '@/app/[locale]/members/productsWorkflowView';

const base = {
  name: 'Kit', quantity: 1, unit_price: 100, line_total: 100, discount: 28,
  promotion_name: null, treatment_action: 'percentage_discount', treatment_value: 20,
  tax_rate_percent: null, tax_amount: 0, amount: 72,
};

describe('discountEntries (#3284)', () => {
  it('words each reason with its type label, in order', () => {
    const entries = discountEntries({ ...base, reasons: [
      { type: 'discount', source: 'promotion', code: null, action: 'waive', value: null, name: 'November free' },
      { type: 'benefit', source: 'membership_plan', code: null, action: 'percentage_discount', value: 20, name: null },
      { type: 'manual_adjustment', source: 'personal', code: 'direct_discount', action: 'percentage_discount', value: 15, name: null },
    ] });
    expect(entries).toEqual([
      { text: 'November free', typeKey: 'checkout_reason_type_discount', separator: ' ' },
      { key: 'checkout_discount_percent', values: { percent: 20 }, typeKey: 'checkout_reason_type_benefit', separator: ' ' },
      { key: 'checkout_discount_direct_percent', values: { percent: 15 }, typeKey: 'checkout_reason_type_manual_adjustment', separator: ' ' },
    ]);
  });

  it('a line with no reasons falls back to its single treatment, untyped; nothing taken off is empty', () => {
    expect(discountEntries(base)).toEqual([{ key: 'checkout_discount_percent', values: { percent: 20 }, typeKey: null, separator: ' ' }]);
    expect(discountEntries({ ...base, discount: 0, reasons: [] })).toEqual([]);
  });
});

describe('Initial Payment waive (#3284 stage 2)', () => {
  it('labels the staff waive Initial payment, after the line\'s own reasons', () => {
    const entries = discountEntries({ ...base, amount: 0, discount: 100, reasons: [
      { type: 'benefit', source: 'membership_plan', code: null, action: 'percentage_discount', value: 20, name: null },
      { type: 'manual_adjustment', source: 'personal', code: 'initial_payment_waive', action: 'waive', value: null, name: null },
    ] });
    expect(entries.at(-1)).toEqual({ key: 'checkout_reason_initial_payment_waived', typeKey: 'checkout_reason_type_initial_payment', separator: ': ' });
  });

  it('picks Revert waive on a waived line, Waive otherwise, nothing without a key', () => {
    expect(initialPaymentLineAction({ line_key: 'a', waived: true, waivable: false })).toEqual({ kind: 'revert', lineKey: 'a', enabled: true });
    expect(initialPaymentLineAction({ line_key: 'a', waived: false, waivable: true })).toEqual({ kind: 'waive', lineKey: 'a', enabled: true });
    expect(initialPaymentLineAction({ line_key: 'a', waived: false, waivable: false }))
      .toEqual({ kind: 'waive', lineKey: 'a', enabled: false, disabledReasonKey: 'checkout_waive_unavailable' });
    expect(initialPaymentLineAction({ line_key: null })).toBeNull();
  });

  it('a disabled Waive states the server\'s reason (#3284 stage 3)', () => {
    expect(initialPaymentLineAction({ line_key: 'a', waivable: false, waive_refusal: 'prepaid_fee' })?.disabledReasonKey)
      .toBe('checkout_waive_error_prepaid');
    expect(initialPaymentLineAction({ line_key: 'a', waivable: true, waive_refusal: null })?.disabledReasonKey).toBeUndefined();
  });
});
