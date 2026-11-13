/**
 * #2770: who may add a Membership Plan or a Product from the Members App. Pure —
 * the SQL half is `api/family-add-rights.ts`.
 *
 * In a Family only the Family Owner adds Plans and Products. Every Member belongs
 * to a Family since #2670, so a Member alone in theirs is its owner and keeps
 * adding as before; a Member with no family row at all (none should exist) is
 * treated the same way, as `resolvePayer()` treats them as their own payer.
 */
export function mayAddPlansAndProducts(memberId: number, familyOwnerMemberId: number | null): boolean {
  return familyOwnerMemberId == null || familyOwnerMemberId === memberId;
}

export const FAMILY_OWNER_ONLY = 'family_owner_only';

/** The 403 body every add route answers a Family member who is not its owner. */
export function familyOwnerOnlyBody() {
  return {
    error: FAMILY_OWNER_ONLY,
    message: 'Only the Family Owner can add Plans or Products',
  };
}
