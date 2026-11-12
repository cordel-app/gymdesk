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

/**
 * #2731 — the same rule as `isUpcomingBooking()`, spelled in SQL for the
 * paginated Past Bookings read, which filters and counts in the database
 * rather than loading the whole history. `ceb` is the booking, `ce` its event.
 * A booking is past exactly when this fragment is true, so the two reads can
 * never place one booking in both lists or in neither.
 */
export const UPCOMING_BOOKING_SQL =
  `(COALESCE(ce.ends_at, ce.starts_at) > UTC_TIMESTAMP()
    AND COALESCE(ce.status, '') <> 'cancelled'
    AND COALESCE(ceb.status, '') IN (${LIVE_BOOKING_STATUSES.map((s) => `'${s}'`).join(', ')}))`;
export const PAST_BOOKING_SQL = `NOT ${UPCOMING_BOOKING_SQL}`;

/** #2731 §3 — at most this many past bookings per page. */
export const PAST_BOOKINGS_PAGE_SIZE = 100;

/**
 * #2731 §2 — the Status filter offers the statuses the Bookings tab *shows*
 * (`bookingStatusKey()` in the admin): attendance once recorded on a booked
 * place, else the booking's own status. `booked` therefore means a booked place
 * with no recorded attendance.
 */
export const PAST_BOOKING_STATUS_FILTERS = ['booked', 'present', 'absent', 'waitlisted', 'cancelled'] as const;
export type PastBookingStatusFilter = (typeof PAST_BOOKING_STATUS_FILTERS)[number];

const STATUS_FILTER_SQL: Record<PastBookingStatusFilter, string> = {
  booked: `(ceb.status = 'booked' AND (ceb.attendance_status IS NULL OR ceb.attendance_status NOT IN ('present', 'absent')))`,
  present: `(ceb.status = 'booked' AND ceb.attendance_status = 'present')`,
  absent: `(ceb.status = 'booked' AND ceb.attendance_status = 'absent')`,
  waitlisted: `(ceb.status = 'waitlisted')`,
  cancelled: `(ceb.status = 'cancelled')`,
};

export interface PastBookingsQuery {
  page: number;
  activity_type_id: number | null;
  center_id: number | null;
  trainer_membership_id: number | null;
  professional_service_id: number | null;
  status: PastBookingStatusFilter | null;
}

const ID_FILTERS = ['activity_type_id', 'center_id', 'trainer_membership_id', 'professional_service_id'] as const;

function present(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * Judges the query string of `GET /members/:id/bookings/past`. An absent or
 * blank filter is "any"; a malformed one is an error, never coerced.
 */
export function parsePastBookingsQuery(q: Record<string, unknown>): { ok: true; value: PastBookingsQuery } | { ok: false; error: string } {
  const value: PastBookingsQuery = {
    page: 1, activity_type_id: null, center_id: null, trainer_membership_id: null, professional_service_id: null, status: null,
  };
  if (q.page !== undefined) {
    if (!present(q.page) || !/^\d+$/.test(q.page) || Number(q.page) < 1) return { ok: false, error: 'page must be a positive integer' };
    value.page = Number(q.page);
  }
  for (const key of ID_FILTERS) {
    const raw = q[key];
    if (raw === undefined || raw === '') continue;
    if (!present(raw) || !/^\d+$/.test(raw) || Number(raw) < 1) return { ok: false, error: `${key} must be a positive integer` };
    value[key] = Number(raw);
  }
  if (q.status !== undefined && q.status !== '') {
    if (!(PAST_BOOKING_STATUS_FILTERS as readonly unknown[]).includes(q.status)) {
      return { ok: false, error: `status must be one of ${PAST_BOOKING_STATUS_FILTERS.join(', ')}` };
    }
    value.status = q.status as PastBookingStatusFilter;
  }
  return { ok: true, value };
}

/** The WHERE conditions the filters add (all combined with AND) and their parameters. */
export function pastBookingFilterSql(f: PastBookingsQuery): { sql: string; params: number[] } {
  const parts: string[] = [];
  const params: number[] = [];
  if (f.activity_type_id != null) { parts.push('ce.activity_type_id = ?'); params.push(f.activity_type_id); }
  if (f.center_id != null) { parts.push('ce.center_id = ?'); params.push(f.center_id); }
  if (f.trainer_membership_id != null) { parts.push('ce.trainer_membership_id = ?'); params.push(f.trainer_membership_id); }
  if (f.professional_service_id != null) { parts.push('ceb.professional_service_id = ?'); params.push(f.professional_service_id); }
  if (f.status != null) parts.push(STATUS_FILTER_SQL[f.status]);
  return { sql: parts.map((p) => ` AND ${p}`).join(''), params };
}
