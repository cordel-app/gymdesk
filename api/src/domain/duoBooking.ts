/**
 * #1984 stage 2b-1: a Duo booking is two participants booked and cancelled as
 * one unit. This is the pure half: what a request may name and which rows a
 * cancellation takes with it. The SQL half is `api/duo-booking.ts`.
 */
import crypto from 'crypto';

/** A Duo group has exactly two participants: the booker and one partner. */
export const MAX_PARTNERS = 1;

export type ParticipantsResult =
  | { ok: true; partnerIds: number[] }
  | { ok: false; error: string };

/**
 * Judges `participant_member_ids` from a request; absent/empty = a solo booking.
 * `maxPartners` is the Duo's one partner unless the caller decides otherwise: a
 * family group booking (#2674) is bounded by its service's capacity instead,
 * which `domain/familyGroupBooking.ts` judges.
 */
export function parseParticipantIds(raw: unknown, bookerId: number, maxPartners: number = MAX_PARTNERS): ParticipantsResult {
  if (raw === undefined || raw === null) return { ok: true, partnerIds: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'participant_member_ids must be an array' };
  const ids: number[] = [];
  for (const v of raw) {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) return { ok: false, error: 'participant_member_ids must contain positive integers' };
    if (n === bookerId) return { ok: false, error: 'The booker cannot also be named as a participant' };
    if (!ids.includes(n)) ids.push(n);
  }
  if (ids.length > maxPartners) return { ok: false, error: `A booking can name at most ${maxPartners} other participant` };
  return { ok: true, partnerIds: ids };
}

export function newBookingGroupId(): string {
  return crypto.randomUUID();
}
