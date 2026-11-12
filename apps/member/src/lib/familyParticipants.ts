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

/**
 * #2674 follow-up — the service whose family selection the screen shows: the
 * chosen one when it qualifies, else (nothing chosen yet, e.g. the member's
 * balance leaves no service preselected) the event's one qualifying service.
 * A chosen `open_group` service shows no selection.
 */
export function groupServiceOf<T extends GroupService & { id: number }>(
  services: T[] | null | undefined, chosenId: number | null,
): T | null {
  const list = services ?? [];
  if (chosenId != null) {
    const chosen = list.find((s) => s.id === chosenId);
    if (chosen) return isFamilyGroupService(chosen) ? chosen : null;
  }
  const qualifying = list.filter(isFamilyGroupService);
  return qualifying.length === 1 ? qualifying[0] : null;
}

/** Whether a family member's toggle may move: off needs room above `min`, on needs room below `max`. */
export function canToggleParticipant(partnerIds: number[], id: number, min: number, max: number): boolean {
  return partnerIds.includes(id) ? canRemoveParticipant(partnerIds, min) : canAddParticipant(partnerIds, max);
}

/**
 * The selection after toggling one family member, kept in the family's order
 * (alphabetical, as §2 seeds it); a move the limits refuse changes nothing.
 */
export function toggleParticipant(
  bookerId: number, family: FamilyMember[], partnerIds: number[], id: number, min: number, max: number,
): number[] {
  if (id === bookerId || !family.some((m) => m.member_id === id)) return partnerIds;
  if (!canToggleParticipant(partnerIds, id, min, max)) return partnerIds;
  const next = partnerIds.includes(id) ? partnerIds.filter((p) => p !== id) : [...partnerIds, id];
  const order = addableMembers(bookerId, family, []).map((m) => m.member_id);
  return order.filter((m) => next.includes(m));
}
