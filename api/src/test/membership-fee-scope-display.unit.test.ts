// #2834 stage 2 — how the Membership Fee is drawn by its scope (#2800's rule): the Admin's
// Assigned Plan grid draws one fee row for a `per_family` plan (Member column *Family*) and one
// per beneficiary for a `per_member` plan; the Members App says *Per member × N* / *Per family*
// beside a held plan's price. Both are pure modules; the figures stay the server's.
//
// In the API suite for #1009's reason: CI runs `npm test` in `api/` only.
import { describe, expect, it } from 'vitest';
import {
  feeMemberDiscountsPayload, feeRowDiscountText, feeRowFinalPrice, membershipFeeRowSlots,
} from '../../../apps/admin/src/lib/membershipFeeRows';
import { planFeeScopeNote } from '../../../apps/member/src/lib/memberProducts';
import { membershipFeeUnits } from '../domain/membershipFeeScope';

const people = (n: number) => Array.from({ length: n }, (_, i) => ({ member_id: i + 1, name: `M${i + 1}` }));

describe('Admin — Membership Fee rows by scope', () => {
  it.each([1, 2, 3])('per_family with %i beneficiaries is one Family row', (n) => {
    expect(membershipFeeRowSlots('per_family', people(n)))
      .toEqual([{ member_id: null, member_name: null, family: true, own_discount: null }]);
  });

  it.each([1, 2, 3])('per_member with %i beneficiaries is one row each, naming them', (n) => {
    const slots = membershipFeeRowSlots('per_member', people(n));
    expect(slots.map((s) => s.member_name)).toEqual(people(n).map((p) => p.name));
    expect(slots.every((s) => !s.family)).toBe(true);
  });

  it('draws as many fee rows as the engine charges fees', () => {
    for (const scope of ['per_member', 'per_family'] as const) {
      for (const n of [0, 1, 2, 3]) {
        expect(membershipFeeRowSlots(scope, people(n))).toHaveLength(membershipFeeUnits(scope, n));
      }
    }
  });

  it('a per_member plan covering nobody still owes one fee: one row with no member', () => {
    expect(membershipFeeRowSlots('per_member', [])).toEqual([{ member_id: null, member_name: null, family: false, own_discount: null }]);
  });

  it('an unknown or absent scope reads as the default, per_family', () => {
    expect(membershipFeeRowSlots(null, people(2))[0].family).toBe(true);
    expect(membershipFeeRowSlots('bogus', people(2))).toHaveLength(1);
  });
});

describe('Members App — the scope note beside a held plan', () => {
  it('per_member carries the fee count', () => {
    expect(planFeeScopeNote({ membership_fee_scope: 'per_member', membership_fee_units: 3 }))
      .toEqual({ key: 'plan_fee_per_member', values: { count: 3 } });
  });
  it('per_family is one fee', () => {
    expect(planFeeScopeNote({ membership_fee_scope: 'per_family', membership_fee_units: 1 }))
      .toEqual({ key: 'plan_fee_per_family', values: { count: 1 } });
  });
  it('a response without the field says nothing', () => {
    expect(planFeeScopeNote({})).toBeNull();
  });
});

// #2945 — each per-member fee row reads, prices and saves its own Direct Discount.
describe('Admin — per-member fee row discounts (#2945)', () => {
  const ben = [
    { member_id: 1, name: 'Xavier', fee_direct_discount_percent: '50.00' },
    { member_id: 2, name: 'Test1', fee_direct_discount_percent: null },
  ];
  const slots = membershipFeeRowSlots('per_member', ben);

  it('a row reads its own discount, else the shared one', () => {
    expect(slots.map((s) => s.own_discount)).toEqual([50, null]);
    expect(slots.map((s) => feeRowDiscountText(s, '10'))).toEqual(['50', '10']);
    expect(feeRowDiscountText({ ...slots[0], own_discount: 0 }, '10')).toBe('');
  });

  it('a row with its own discount reads its own server price', () => {
    expect(feeRowFinalPrice(slots[0], 40, { 1: 25 })).toBe(25);
    expect(feeRowFinalPrice(slots[1], 40, { 1: 25 })).toBe(40);
  });

  it('Save sends only the rows that changed, each with its own value', () => {
    expect(feeMemberDiscountsPayload(slots, ['50', '10'], ['25', '10'])).toEqual([{ member_id: 1, percent: 25 }]);
    expect(feeMemberDiscountsPayload(slots, ['50', '10'], ['50', ''])).toEqual([{ member_id: 2, percent: 0 }]);
    expect(feeMemberDiscountsPayload(slots, ['50', '10'], ['50', '10'])).toEqual([]);
    expect(feeMemberDiscountsPayload(membershipFeeRowSlots('per_family', ben), [''], ['5'])).toBeNull();
  });
});
