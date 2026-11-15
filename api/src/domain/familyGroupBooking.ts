/**
 * #2674 / #2813 — a family booking: a member books a `family_only` Professional
 * Service, naming the other members of their Family who attend with them. Since
 * #2813 each selected member gets an individual booking of their own (no
 * `booking_group_id`): each passes the booking gate and reserves its own unit,
 * the initiator recorded as `booked_by_member_id` on every row. The family's
 * bookings of one occurrence and service still answer to the service's minimum
 * together: a cancellation that leaves fewer than the minimum cancels the rest
 * (`cancelsRemainingFamilyBookings()`).
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

/** Every `family_only` service takes a participant selection (#2813 §1; #2674 also required a minimum above one). */
export function isFamilyGroupService(s: GroupServiceShape | null | undefined): boolean {
  return !!s && s.booking_type === 'family_only';
}

/**
 * #2813 §6: after one family member cancels, whether the family's remaining
 * bookings of that occurrence and service are cancelled too — some remain, but
 * fewer than the service's minimum.
 */
export function cancelsRemainingFamilyBookings(remaining: number, minParticipants: number | null | undefined): boolean {
  return remaining > 0 && remaining < Math.max(1, Number(minParticipants ?? 1));
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
 * #2850: whether the booker attends the family booking themselves. Absent keeps
 * the pre-#2850 behaviour (they attend); only a boolean is accepted, never a
 * coercion (the string `"false"` is truthy).
 */
export function parseBookerAttends(raw: unknown): { ok: true; value: boolean } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: true };
  if (typeof raw !== 'boolean') return { ok: false, error: 'booker_attends must be a boolean' };
  return { ok: true, value: raw };
}

/**
 * Judges a family group selection. The count includes the booker when they
 * attend (§4; #2850: a booker may book only for other family members, so
 * `bookerAttends` false leaves them out of the count). Every partner must be a
 * member of the booker's family (§3); `familyMemberIds` is that family, the
 * booker included or not.
 */
export function judgeFamilyParticipants(input: {
  bookerId: number;
  partnerIds: number[];
  familyMemberIds: number[];
  min: number;
  max: number;
  bookerAttends?: boolean;
}): { ok: true } | { ok: false; code: FamilyGroupRefusal } {
  const family = new Set(input.familyMemberIds.map(Number));
  if (input.partnerIds.some((id) => id === input.bookerId || !family.has(id))) {
    return { ok: false, code: 'participant_not_in_family' };
  }
  const count = (input.bookerAttends === false ? 0 : 1) + input.partnerIds.length;
  if (count === 0) return { ok: false, code: 'participants_below_minimum' };
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
