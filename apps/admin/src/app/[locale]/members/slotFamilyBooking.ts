// #3090 stage 3 — pure rules for booking the grid's slots for several members
// of one family. The API (`POST …/personal-training-slots/book-family`) judges
// everything (family membership, eligibility, capacity); this only builds the
// request and words its per-member answer as locale keys.

export interface FamilyMember {
  member_id: number;
  name: string;
  is_owner: boolean;
}

export interface FamilyBookMemberResult {
  member_id: number;
  created: number;
  skipped: number;
  failed: number;
  error?: string;
}

/** The members offered besides the one whose card is open; none when the family is just them. */
export function otherFamilyMembers(memberId: number, family: FamilyMember[]): FamilyMember[] {
  return family.filter((m) => m.member_id !== memberId);
}

/** The card's member first, then the ticked ones, each once, only ids the family holds. */
export function familyBookingMemberIds(memberId: number, ticked: number[], family: FamilyMember[]): number[] {
  const allowed = new Set(otherFamilyMembers(memberId, family).map((m) => m.member_id));
  return [memberId, ...Array.from(new Set(ticked)).filter((id) => allowed.has(id))];
}

/** Which route a Book press calls: the member's own, or the family one. */
export function bookPath(memberId: number, memberIds: number[]): string {
  return memberIds.length > 1
    ? `/members/${memberId}/personal-training-slots/book-family`
    : `/members/${memberId}/personal-training-slots/book`;
}

/** The locale key (under `members`) explaining a member the run did not book at all. */
export function familyResultErrorKey(result: FamilyBookMemberResult): string | null {
  return result.error === 'slot_not_available' ? 'pt_slots_family_not_available' : null;
}
