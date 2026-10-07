// #1162 — the SQL half of `domain/bookingCancellation.ts`: the three
// expressions a read projects beside a booking, and the one shaping function
// every member-facing booking read and the member's own DELETE go through.
import { decideMemberCancellation, type CancellationBlock } from '../domain/bookingCancellation';

/** Seconds until the occurrence starts, negative once it has — compared in SQL, so no DATETIME crosses a timezone. */
export function secondsUntilStartSql(ce = 'ce'): string {
  return `TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), ${ce}.starts_at)`;
}

/** Seconds since the booking was created; NULL for a row with no `booked_at` (a waiting-list place, a legacy row). */
export function secondsSinceBookedSql(ceb = 'ceb'): string {
  return `TIMESTAMPDIFF(SECOND, ${ceb}.booked_at, UTC_TIMESTAMP())`;
}

/**
 * Whether the occurrence is linked to a Professional Service — it delivers one
 * (`calendar_events.professional_service_id`, #647) or requires one to be
 * booked (the occurrence's own Eligible Professional Services when it
 * overrides, else its Activity Type's, #973/#980). The refusal is worded for
 * such a booking (#1162 §5), and the Members App decides the wording from
 * this flag rather than from a second rule.
 */
export function professionalServiceLinkedSql(ce = 'ce'): string {
  return `(${ce}.professional_service_id IS NOT NULL OR IF(${ce}.eligible_services_override = 1,
    EXISTS (SELECT 1 FROM calendar_event_eligible_professional_services ceeps WHERE ceeps.calendar_event_id = ${ce}.id),
    EXISTS (SELECT 1 FROM activity_type_eligible_professional_services ateps WHERE ateps.activity_type_id = ${ce}.activity_type_id)))`;
}

export interface CancellationTimingRow {
  status?: string | null;
  seconds_until_start: number | string | null;
  seconds_since_booked: number | string | null;
}

export interface MemberCancellationFields {
  can_cancel: boolean;
  cancellation_block: CancellationBlock | null;
}

/** The two fields a member-facing read reports, from the row's own numbers. */
export function memberCancellation(row: CancellationTimingRow, status: string | null = row.status ?? null): MemberCancellationFields {
  const decision = decideMemberCancellation({
    status,
    secondsUntilStart: Number(row.seconds_until_start ?? 0),
    secondsSinceBooked: row.seconds_since_booked === null || row.seconds_since_booked === undefined
      ? null
      : Number(row.seconds_since_booked),
  });
  return { can_cancel: decision.allowed, cancellation_block: decision.block };
}

/**
 * The helper columns a read projected to decide with, removed before the row
 * reaches the client — what a client gets is the decision and `booked_on`.
 */
export function withoutCancellationTiming<T extends Record<string, unknown>>(row: T): Omit<T, 'seconds_until_start' | 'seconds_since_booked'> {
  const { seconds_until_start: _a, seconds_since_booked: _b, ...rest } = row;
  return rest;
}
