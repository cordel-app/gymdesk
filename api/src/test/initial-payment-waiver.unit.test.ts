// #3284 stage 2 — the pure half of the Initial Payment waive: line identity, refusals, application.
import { describe, expect, it } from 'vitest';
import type { BillingEventLineRow } from '../domain/billingEventLines';
import {
  applyInitialPaymentWaivers, initialPaymentLineKeys, INITIAL_PAYMENT_WAIVE_REASON, waiveRefusal,
} from '../domain/initialPaymentWaiver';

const line = (key: string, amount: number, extra: Partial<BillingEventLineRow> = {}): BillingEventLineRow => ({
  kind: 'product', source: 'plan', product_id: 1, item_name: key, item_type: null, quantity: 1,
  regular_unit_price: amount, treatment_action: 'no_benefit', treatment_value: null, promotion_name: null,
  prorated_days: null, period_days: null, tax_rate_percent: 21, tax_behavior: 'inclusive',
  amount_excl_tax: Math.round((amount / 1.21) * 100) / 100, amount, reasons: [], line_key: key, ...extra,
});

describe('initialPaymentLineKeys()', () => {
  it('names a line by what it is and tells repeated identities apart by occurrence', () => {
    expect(initialPaymentLineKeys([
      { kind: 'membership_fee', assignmentId: 7 },
      { kind: 'product', assignmentId: 7, productId: 3, assignedMemberId: 11 },
      { kind: 'product', assignmentId: 7, productId: 3, assignedMemberId: 12 },
      { kind: 'product', assignmentId: 7, productId: 3, assignedMemberId: 11 },
      { kind: 'product', lineRef: 90, productId: 3 },
      { kind: 'product', purchaseId: 5, productId: 3 },
    ])).toEqual(['fee:7:0', 'item:7:3:11', 'item:7:3:12', 'item:7:3:11#2', 'ref:90', 'purchase:5']);
  });
});

describe('waiveRefusal()', () => {
  const lines = [line('a', 40), line('b', 60), line('c', 0)];
  it('allows a positive line while something is left to pay', () => {
    expect(waiveRefusal(lines, 'b', new Set())).toBeNull();
  });
  it('refuses an unknown, already waived, zero or last remaining line', () => {
    expect(waiveRefusal(lines, 'x', new Set())).toBe('line_not_found');
    expect(waiveRefusal(lines, 'b', new Set(['b']))).toBe('already_waived');
    expect(waiveRefusal(lines, 'c', new Set())).toBe('nothing_to_waive');
    expect(waiveRefusal(lines, 'a', new Set(['b']))).toBe('would_leave_nothing_to_pay');
  });
  it('refuses a Membership Fee that collects a Pre-paid Duration', () => {
    const fee = line('f', 120, { kind: 'membership_fee', prepaid_periods: 3 });
    expect(waiveRefusal([fee, line('a', 10)], 'f', new Set())).toBe('prepaid_fee');
  });
});

describe('applyInitialPaymentWaivers()', () => {
  it('zeroes only the waived line, keeps its price and adds the manual adjustment after its reasons', () => {
    const reason = { type: 'benefit' as const, source: 'membership_plan' as const, code: null, action: 'percentage_discount', value: 20, name: null };
    const out = applyInitialPaymentWaivers([line('a', 40), line('b', 60, { reasons: [reason] }), line('c', 5)], new Set(['b']));
    expect(out[0]).toMatchObject({ amount: 40, waived: false, waivable: true });
    expect(out[2]).toMatchObject({ amount: 5, waived: false, waivable: true });
    expect(out[1]).toMatchObject({ amount: 0, amount_excl_tax: 0, regular_unit_price: 60, quantity: 1, waived: true, waivable: false });
    expect(out[1].reasons).toEqual([reason, INITIAL_PAYMENT_WAIVE_REASON]);
  });
  it('ignores a stale waiver whose line is gone or now collects a Pre-paid Duration', () => {
    const out = applyInitialPaymentWaivers(
      [line('a', 40), line('f', 90, { kind: 'membership_fee', prepaid_periods: 2 })], new Set(['gone', 'f']));
    expect(out.map((l) => l.amount)).toEqual([40, 90]);
    expect(out.every((l) => l.waived === false)).toBe(true);
  });
  it('does not offer Waive on the last line left to pay', () => {
    const out = applyInitialPaymentWaivers([line('a', 40), line('b', 60)], new Set(['b']));
    expect(out[0].waivable).toBe(false);
  });
});
