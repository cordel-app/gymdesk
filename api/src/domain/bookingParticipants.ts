/**
 * #1984 stage 2b — the people a member books a place for beside their own.
 *
 * Pure: the request judgement. Who may be named (a linked member with sessions
 * for the service, not already on the event) is `api/booking-participants.ts`,
 * which asks the one eligibility decision rather than restating it.
 *
 * A participant is a booking row of their own (`calendar_event_bookings.member_id`)
 * and `booked_by_member_id` records who put them there, so capacity, uniqueness
 * and the session ledger keep working per person. Selecting one spends nothing
 * extra by itself: sessions are spent on attendance, as for any booking (#1189).
 */

/** More than this in one request is a mistake, not a booking. */
export const MAX_PARTICIPANTS_PER_BOOKING = 10;

export type ParticipantIdsResult = { ok: true; ids: number[] } | { ok: false; error: string };

/**
 * `participant_member_ids`: absent or `null` is no participant, an array of
 * positive integers is the list (duplicates folded), anything else is a 400 and
 * never a coercion. The booker is not a participant of their own booking.
 */
export function parseParticipantIdsInput(raw: unknown, bookerId: number): ParticipantIdsResult {
  if (raw === undefined || raw === null) return { ok: true, ids: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'participant_member_ids must be an array' };
  const ids: number[] = [];
  for (const value of raw) {
    const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
      return { ok: false, error: 'participant_member_ids must be positive integers' };
    }
    if (n === bookerId) return { ok: false, error: 'The booker cannot be named as a participant' };
    if (!ids.includes(n)) ids.push(n);
  }
  if (ids.length > MAX_PARTICIPANTS_PER_BOOKING) {
    return { ok: false, error: `At most ${MAX_PARTICIPANTS_PER_BOOKING} participants per booking` };
  }
  return { ok: true, ids };
}
