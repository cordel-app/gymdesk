// #3284 stage 2 — the pure half of the Initial Payment waive: line identity, refusals, application.
import { describe, expect, it } from 'vitest';
import type { BillingEventLineRow } from '../domain/billingEventLines';
import {
  applyInitialPaymentWaivers, initialPaymentLineKeys, INITIAL_PAYMENT_WAIVE_REASON, splitPrepaidMembershipFees, waiveRefusal,
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
  it('refuses an unknown, already waived or zero line', () => {
    expect(waiveRefusal(lines, 'x', new Set())).toBe('line_not_found');
    expect(waiveRefusal(lines, 'b', new Set(['b']))).toBe('already_waived');
    expect(waiveRefusal(lines, 'c', new Set())).toBe('nothing_to_waive');
  });
  it('allows the last line left to pay: the Initial Payment may be waived to zero (stage 4)', () => {
    expect(waiveRefusal(lines, 'a', new Set(['b']))).toBeNull();
    expect(waiveRefusal([line('only', 25)], 'only', new Set())).toBeNull();
  });
  it('allows a Membership Fee that collects a Pre-paid Duration (#3440 stage 2)', () => {
    const fee = line('f', 120, { kind: 'membership_fee', prepaid_periods: 3 });
    expect(waiveRefusal([fee, line('a', 10)], 'f', new Set())).toBeNull();
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
  it('ignores a stale waiver whose line is gone or now owes nothing', () => {
    const out = applyInitialPaymentWaivers([line('a', 40), line('z', 0)], new Set(['gone', 'z']));
    expect(out.map((l) => l.amount)).toEqual([40, 0]);
    expect(out.every((l) => l.waived === false)).toBe(true);
  });
  it('still offers Waive on the last line left to pay (stage 4)', () => {
    const out = applyInitialPaymentWaivers([line('a', 40), line('b', 60)], new Set(['b']));
    expect(out[0]).toMatchObject({ waivable: true, waive_refusal: null });
    const all = applyInitialPaymentWaivers([line('a', 40), line('b', 60)], new Set(['a', 'b']));
    expect(all.map((l) => l.amount)).toEqual([0, 0]);
    expect(all.every((l) => l.waived)).toBe(true);
  });
});

describe('a prorated Membership Fee (#3284 stage 3)', () => {
  const split = (prepaid: boolean) => ({
    prorated: { days: 7, period_days: 30, start: '2026-11-24', end: '2026-11-30', amount: 9.33 },
    prepaid: prepaid ? { periods: 2, start: '2026-12-01', end: '2027-01-31', amount: 80 } : null,
  });
  it('may be waived when its split collects no Pre-paid Duration', () => {
    const fee = line('f', 9.33, { kind: 'membership_fee', fee_split: split(false) });
    expect(waiveRefusal([fee, line('a', 17.5)], 'f', new Set())).toBeNull();
    const shown = applyInitialPaymentWaivers([fee, line('a', 17.5)], new Set());
    expect(shown[0]).toMatchObject({ waivable: true, waive_refusal: null });
  });
});

describe('splitPrepaidMembershipFees() (#3440 stage 2)', () => {
  const feeSplit = {
    prorated: { days: 7, period_days: 30, start: '2026-11-24', end: '2026-11-30', amount: 9.33 },
    prepaid: { periods: 2, start: '2026-12-01', end: '2027-01-31', amount: 80 },
  };
  const fee = line('fee:7:0', 89.33, {
    kind: 'membership_fee', regular_unit_price: 80, prorated_days: 7, period_days: 30,
    prepaid_periods: 2, prepaid_cadence: { interval: 1, unit: 'month' }, fee_split: feeSplit,
  });

  it('makes the prorated stretch and the prepayment two lines that reconcile to the cent', () => {
    const { lines, index } = splitPrepaidMembershipFees([line('a', 10), fee, line('b', 5)]);
    expect(index).toEqual([0, 1, 3]);
    expect(lines.map((l) => l.line_key)).toEqual(['a', 'fee:7:0', 'fee:7:0:prepaid', 'b']);
    const [, prorated, prepaid] = lines;
    expect(prorated).toMatchObject({
      amount: 9.33, amount_excl_tax: 7.71, regular_unit_price: 9.33, prorated_days: 7, period_days: 30,
      prepaid_periods: null, fee_split: { prorated: feeSplit.prorated, prepaid: null },
    });
    expect(prepaid).toMatchObject({
      amount: 80, amount_excl_tax: 66.12, regular_unit_price: 80, prorated_days: null, period_days: null,
      prepaid_periods: 2, fee_split: { prorated: null, prepaid: feeSplit.prepaid },
    });
    expect(Math.round((prorated.amount + prepaid.amount) * 100) / 100).toBe(89.33);
  });

  it('keeps one line for a fee with no prepayment, and for any other line', () => {
    const proratedOnly = line('fee:8:0', 9.33, { kind: 'membership_fee', fee_split: { ...feeSplit, prepaid: null } });
    const prepaidOnly = line('fee:9:0', 80, { kind: 'membership_fee', prepaid_periods: 2 });
    const { lines } = splitPrepaidMembershipFees([proratedOnly, prepaidOnly, line('a', 10)]);
    expect(lines).toHaveLength(3);
  });

  it('lets either part be waived without touching the other', () => {
    const { lines } = splitPrepaidMembershipFees([fee]);
    expect(waiveRefusal(lines, 'fee:7:0:prepaid', new Set())).toBeNull();
    const out = applyInitialPaymentWaivers(lines, new Set(['fee:7:0:prepaid']));
    expect(out.map((l) => [l.amount, l.waived])).toEqual([[9.33, false], [0, true]]);
    const other = applyInitialPaymentWaivers(lines, new Set(['fee:7:0']));
    expect(other.map((l) => [l.amount, l.waived])).toEqual([[0, true], [80, false]]);
  });
});

describe('which lines are offered Waive (#3440)', () => {
  it('offers it on every positive line a Membership Plan adds and on none at €0.00', () => {
    const fee = line('fee', 49.9, { kind: 'membership_fee' });
    const included = line('included', 12);
    const free = line('free', 0, { treatment_action: 'waive' });
    const shown = applyInitialPaymentWaivers([fee, included, free], new Set());
    expect(shown.map((l) => l.waivable)).toEqual([true, true, false]);
    expect(waiveRefusal([fee, included, free], 'fee', new Set())).toBeNull();
  });
});
