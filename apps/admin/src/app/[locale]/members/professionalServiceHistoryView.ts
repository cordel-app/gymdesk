// #2670 stage 3 — the Professional Services history is the Family wallet's
// (stage 2): every member of a family sees the same entries. An entry carries
// the member it was recorded for (`member_id` / `member_name`): the member who
// booked, for a spent or returned session, and the member a correction was
// entered from, for a manual adjustment. This module decides when that member
// is named beside the entry, so the history reads the same from every card.
//
// The member is named only when it is **another** member of the family: on a
// solo family's card (every member's, before families existed) nothing is
// added, so the section reads exactly as it did.

export interface HistoryEntryMember {
  member_id?: number | null;
  member_name?: string | null;
}

/** The family member to name beside a history entry, or null for none. */
export function historyEntryMemberName(entry: HistoryEntryMember, viewedMemberId: number): string | null {
  if (entry.member_id == null || entry.member_id === viewedMemberId) return null;
  const name = entry.member_name?.trim();
  return name ? name : null;
}
