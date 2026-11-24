// #3284 — the Initial Payment's Benefit / discount cell words every treatment the server classified.
import { describe, expect, it } from 'vitest';
import { discountEntries } from '@/app/[locale]/members/productsWorkflowView';

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
      { text: 'November free', typeKey: 'checkout_reason_type_discount' },
      { key: 'checkout_discount_percent', values: { percent: 20 }, typeKey: 'checkout_reason_type_benefit' },
      { key: 'checkout_discount_direct_percent', values: { percent: 15 }, typeKey: 'checkout_reason_type_manual_adjustment' },
    ]);
  });

  it('a line with no reasons falls back to its single treatment, untyped; nothing taken off is empty', () => {
    expect(discountEntries(base)).toEqual([{ key: 'checkout_discount_percent', values: { percent: 20 }, typeKey: null }]);
    expect(discountEntries({ ...base, discount: 0, reasons: [] })).toEqual([]);
  });
});
