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

export interface FeeBeneficiary {
  member_id: number | string;
  name?: string | null;
  /** #2945 — this beneficiary's own fee Direct Discount (%); null follows the shared benefit. */
  fee_direct_discount_percent?: number | string | null;
}

export interface MembershipFeeRowSlot {
  /** `null` for the Family row (and for a per-member plan that covers nobody). */
  member_id: number | null;
  member_name: string | null;
  /** True for the one row of a `per_family` assignment: the Member column reads *Family*. */
  family: boolean;
  /** #2945 — this row's own Direct Discount (%), `null` when it follows the shared benefit. */
  own_discount: number | null;
}

export function membershipFeeRowSlots(
  scope: unknown,
  beneficiaries: FeeBeneficiary[] | null | undefined,
): MembershipFeeRowSlot[] {
  const s: MembershipFeeScope = toMembershipFeeScope(scope);
  const list = beneficiaries ?? [];
  if (s === 'per_family') return [{ member_id: null, member_name: null, family: true, own_discount: null }];
  if (list.length === 0) return [{ member_id: null, member_name: null, family: false, own_discount: null }];
  return list.map((b) => ({
    member_id: Number(b.member_id),
    member_name: b.name ?? null,
    family: false,
    own_discount: b.fee_direct_discount_percent == null || b.fee_direct_discount_percent === ''
      ? null : Number(b.fee_direct_discount_percent),
  }));
}

/**
 * #2945 — the Direct Discount (%) a fee row reads, as its cell's text: its own when it has one
 * (`0` reads empty, no discount), else the assignment's shared benefit (`sharedText`, as
 * `feeDiscountValue()` spells it).
 */
export function feeRowDiscountText(slot: MembershipFeeRowSlot, sharedText: string): string {
  if (slot.own_discount == null) return sharedText;
  return slot.own_discount > 0 ? String(slot.own_discount) : '';
}

/**
 * #2945 — the fee for this row's current cycle: the server's own price for a member whose fee
 * carries its own discount (`byMember`), else the shared one. Nothing is priced here.
 */
export function feeRowFinalPrice(
  slot: MembershipFeeRowSlot, shared: number | null, byMember: Record<string, number> | null | undefined,
): number | null {
  if (slot.member_id == null || !byMember) return shared;
  const own = byMember[String(slot.member_id)];
  return own == null ? shared : own;
}

/**
 * #2945 — what Save sends for the fee rows of a `per_member` plan: one entry per beneficiary row
 * whose text the staff member changed (an untouched row keeps what it stores, §2), `''` read as
 * 0 (no discount). `null` when no row names a member, so the caller sends the shared benefit.
 */
export function feeMemberDiscountsPayload(
  slots: MembershipFeeRowSlot[], initial: string[], typed: string[],
): { member_id: number; percent: number }[] | null {
  if (!slots.some((s) => s.member_id != null)) return null;
  const out: { member_id: number; percent: number }[] = [];
  slots.forEach((slot, i) => {
    if (slot.member_id == null) return;
    const now = (typed[i] ?? '').trim();
    if (now === (initial[i] ?? '').trim()) return;
    out.push({ member_id: slot.member_id, percent: now === '' ? 0 : Number(now) });
  });
  return out;
}
