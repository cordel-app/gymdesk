/**
 * #2720 — which of a Member's bookings are *upcoming* and which are *past*, for
 * the Admin Member card's Bookings tab. The one place that rule lives; the
 * route (`api/member-bookings.ts`) only reads the rows.
 *
 * A booking is **upcoming** while it is still live — its own status is
 * `booked` or `waitlisted` (the ticket's "Booked" and "Pre-booked"), its event
 * is not cancelled and the event has not ended. Everything else is **past**: an
 * event that has ended (whatever the booking's final status), and a booking
 * that is no longer live (cancelled by the member or staff, or on an event the
 * gym cancelled). So each booking lands in exactly one list and none is hidden.
 *
 * `has_ended` is computed in SQL against `UTC_TIMESTAMP()`, so no DATETIME
 * crosses a timezone conversion (#1113's rule). Nothing is stored.
 */

export const LIVE_BOOKING_STATUSES = ['booked', 'waitlisted'] as const;

export interface MemberBookingRow {
  status: string;
  session_status: string | null;
  starts_at: string | Date;
  /** 1/0 (or boolean) from SQL: the event's end (else start) is not in the future. */
  has_ended: number | boolean | string;
}

export function isUpcomingBooking(row: MemberBookingRow): boolean {
  if (Number(row.has_ended)) return false;
  if (row.session_status === 'cancelled') return false;
  return (LIVE_BOOKING_STATUSES as readonly string[]).includes(row.status);
}

const time = (v: string | Date) => new Date(v).getTime();

/** Upcoming nearest first, past most recent first; each row in exactly one list. */
export function splitMemberBookings<T extends MemberBookingRow>(rows: readonly T[]): { upcoming: T[]; past: T[] } {
  const upcoming: T[] = [];
  const past: T[] = [];
  for (const row of rows) (isUpcomingBooking(row) ? upcoming : past).push(row);
  upcoming.sort((a, b) => time(a.starts_at) - time(b.starts_at));
  past.sort((a, b) => time(b.starts_at) - time(a.starts_at));
  return { upcoming, past };
}
