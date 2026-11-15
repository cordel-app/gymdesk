// #2834 stage 2 — the Membership Fee rows of the Assigned Plan card's grid, by the
// assignment's own Membership Fee scope (frozen on its plan snapshot, #2834 stage 1).
//
// #2800's display rule, decided here and nowhere else in the Admin:
// - `per_family`: one fee row for the whole assignment, its Member column reading *Family*;
// - `per_member`: one fee row per beneficiary, its Member column naming that beneficiary.
//
// Pure: no React, no `t()`, no request. The figures on each row are one fee each, exactly the
// fee the server priced (`membership_fee`); nothing is multiplied or re-priced here — the billing
// engine is the one place the fee is multiplied (`membershipFeeUnits()` in the API). A per-member
// assignment whose payer covers nobody still owes one fee, so it reads as one row with no member.
import { toMembershipFeeScope, type MembershipFeeScope } from './membershipFeeScope';

export interface FeeBeneficiary { member_id: number | string; name?: string | null }

export interface MembershipFeeRowSlot {
  /** `null` for the Family row (and for a per-member plan that covers nobody). */
  member_id: number | null;
  member_name: string | null;
  /** True for the one row of a `per_family` assignment: the Member column reads *Family*. */
  family: boolean;
}

export function membershipFeeRowSlots(
  scope: unknown,
  beneficiaries: FeeBeneficiary[] | null | undefined,
): MembershipFeeRowSlot[] {
  const s: MembershipFeeScope = toMembershipFeeScope(scope);
  const list = beneficiaries ?? [];
  if (s === 'per_family') return [{ member_id: null, member_name: null, family: true }];
  if (list.length === 0) return [{ member_id: null, member_name: null, family: false }];
  return list.map((b) => ({
    member_id: Number(b.member_id),
    member_name: b.name ?? null,
    family: false,
  }));
}
