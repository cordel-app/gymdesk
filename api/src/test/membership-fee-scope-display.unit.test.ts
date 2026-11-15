// #2834 stage 2 — how the Membership Fee is drawn by its scope (#2800's rule): the Admin's
// Assigned Plan grid draws one fee row for a `per_family` plan (Member column *Family*) and one
// per beneficiary for a `per_member` plan; the Members App says *Per member × N* / *Per family*
// beside a held plan's price. Both are pure modules; the figures stay the server's.
//
// In the API suite for #1009's reason: CI runs `npm test` in `api/` only.
import { describe, expect, it } from 'vitest';
import { membershipFeeRowSlots } from '../../../apps/admin/src/lib/membershipFeeRows';
import { planFeeScopeNote } from '../../../apps/member/src/lib/memberProducts';
import { membershipFeeUnits } from '../domain/membershipFeeScope';

const people = (n: number) => Array.from({ length: n }, (_, i) => ({ member_id: i + 1, name: `M${i + 1}` }));

describe('Admin — Membership Fee rows by scope', () => {
  it.each([1, 2, 3])('per_family with %i beneficiaries is one Family row', (n) => {
    expect(membershipFeeRowSlots('per_family', people(n)))
      .toEqual([{ member_id: null, member_name: null, family: true }]);
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
    expect(membershipFeeRowSlots('per_member', [])).toEqual([{ member_id: null, member_name: null, family: false }]);
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
