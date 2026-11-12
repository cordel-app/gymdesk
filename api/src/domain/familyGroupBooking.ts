/**
 * #2674 — a family group booking: a member books a `family_only` Professional
 * Service whose minimum is more than one participant, naming the other members
 * of their Family who attend with them. It is one group booking (the existing
 * `booking_group_id` of #1984 stage 2b-1), booked and spent as one unit.
 *
 * Pure: which services take the participant selection, what a selection must
 * satisfy and the initial selection the Members App offers. The SQL half is the
 * `POST /me/bookings` route (`api/me.ts`), which reads the family through
 * `loadEligibleAssignees()` (the one family read, #2609) and books through
 * `bookMemberOnSession()`. The Members App mirrors `initialParticipants()` and
 * the limits in `apps/member/src/lib/familyParticipants.ts`; the server is what
 * enforces them.
 */

export interface GroupServiceShape {
  booking_type: string | null | undefined;
  min_participants: number | null | undefined;
}

/** Only a `family_only` service with a minimum above one takes a participant selection (#2674 §7). */
export function isFamilyGroupService(s: GroupServiceShape | null | undefined): boolean {
  return !!s && s.booking_type === 'family_only' && Number(s.min_participants ?? 1) > 1;
}

export type FamilyGroupRefusal =
  | 'participants_below_minimum'
  | 'participants_above_maximum'
  | 'participant_not_in_family';

export const FAMILY_GROUP_MESSAGES: Record<FamilyGroupRefusal, string> = {
  participants_below_minimum: 'This service needs more participants from your family',
  participants_above_maximum: 'This service does not have room for that many participants',
  participant_not_in_family: 'Every participant must belong to your family',
};

/**
 * Judges a family group selection. The count includes the booker (§4). Every
 * partner must be a member of the booker's family (§3); `familyMemberIds` is
 * that family, the booker included or not.
 */
export function judgeFamilyParticipants(input: {
  bookerId: number;
  partnerIds: number[];
  familyMemberIds: number[];
  min: number;
  max: number;
}): { ok: true } | { ok: false; code: FamilyGroupRefusal } {
  const family = new Set(input.familyMemberIds.map(Number));
  if (input.partnerIds.some((id) => id === input.bookerId || !family.has(id))) {
    return { ok: false, code: 'participant_not_in_family' };
  }
  const count = 1 + input.partnerIds.length;
  if (count < input.min) return { ok: false, code: 'participants_below_minimum' };
  if (count > input.max) return { ok: false, code: 'participants_above_maximum' };
  return { ok: true };
}

/**
 * §2: the booker first, then the other family members alphabetically, until the
 * selection reaches `max` or the family runs out. Returns the partner ids only.
 */
export function initialParticipants(
  bookerId: number, family: { member_id: number; name: string }[], max: number,
): number[] {
  return family
    .filter((m) => m.member_id !== bookerId)
    .sort((a, b) => a.name.localeCompare(b.name) || a.member_id - b.member_id)
    .slice(0, Math.max(0, max - 1))
    .map((m) => m.member_id);
}
