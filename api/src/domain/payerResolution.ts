/**
 * #2123 stage 2: the one rule for who pays an obligation. Pure — the SQL half is
 * `api/payer-resolution.ts`.
 *
 * The *beneficiary* is the Member the Product or Membership Plan belongs to; the *payer* is
 * the Family Owner when the beneficiary is in a family, else the beneficiary. A family
 * member's own stored card is never used for a family obligation, and the owner's is.
 */
export interface ResolvedPayer {
  beneficiaryMemberId: number;
  payerMemberId: number;
  /** True when someone other than the beneficiary pays. */
  viaFamily: boolean;
}

export function resolvePayer(beneficiaryMemberId: number, familyOwnerMemberId: number | null): ResolvedPayer {
  const payer = familyOwnerMemberId ?? beneficiaryMemberId;
  return { beneficiaryMemberId, payerMemberId: payer, viaFamily: payer !== beneficiaryMemberId };
}

/**
 * The payer of a stored row: `payer_member_id` when recorded, else the beneficiary (every
 * row written before migration 345 means "the beneficiary paid").
 */
export function recordedPayer(row: { member_id: number | null; payer_member_id?: number | null }): number | null {
  return row.payer_member_id ?? row.member_id;
}
