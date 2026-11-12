// #2674 — the family members who attend a family group booking with the member.
//
// Pure: no React, no `t()`. Which services take a selection, the initial
// selection and the limits mirror `api/src/domain/familyGroupBooking.ts`; the
// server re-judges every booking, so this only decides what the screen offers.
// The selection holds partner ids: the booker is always in it and never listed.

export interface FamilyMember { member_id: number; name: string }

export interface GroupService {
  booking_type?: string | null;
  min_participants?: number | null;
  /** The service's effective capacity on the occurrence: the group's maximum. */
  capacity: number;
}

/** Only a `family_only` service with a minimum above one takes a selection (§7). */
export function isFamilyGroupService(s: GroupService | null | undefined): boolean {
  return !!s && s.booking_type === 'family_only' && Number(s.min_participants ?? 1) > 1;
}

export function groupLimits(s: GroupService): { min: number; max: number } {
  const min = Math.max(1, Number(s.min_participants ?? 1));
  return { min, max: Math.max(min, Number(s.capacity)) };
}

/** §2: the other family members alphabetically, up to `max` participants with the booker. */
export function initialParticipants(bookerId: number, family: FamilyMember[], max: number): number[] {
  return family
    .filter((m) => m.member_id !== bookerId)
    .sort((a, b) => a.name.localeCompare(b.name) || a.member_id - b.member_id)
    .slice(0, Math.max(0, max - 1))
    .map((m) => m.member_id);
}

/** Family members not yet selected, alphabetically — what Add offers. */
export function addableMembers(bookerId: number, family: FamilyMember[], partnerIds: number[]): FamilyMember[] {
  return family
    .filter((m) => m.member_id !== bookerId && !partnerIds.includes(m.member_id))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function canAddParticipant(partnerIds: number[], max: number): boolean {
  return 1 + partnerIds.length < max;
}

export function canRemoveParticipant(partnerIds: number[], min: number): boolean {
  return 1 + partnerIds.length > min;
}

/** §4: Book is enabled only while the count (booker included) is within the limits. */
export function participantsValid(partnerIds: number[], min: number, max: number): boolean {
  const n = 1 + partnerIds.length;
  return n >= min && n <= max;
}
