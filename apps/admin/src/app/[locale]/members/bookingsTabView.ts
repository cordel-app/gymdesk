/**
 * #2720 — what the Member card's Bookings tab says about one booking. Pure: the
 * split into upcoming and past is the API's (`domain/memberBookingHistory.ts`),
 * this module only picks locale keys and joins the location line.
 */

export interface MemberBooking {
  id: number;
  status: 'booked' | 'waitlisted' | 'cancelled' | string;
  waitlist_position: number | null;
  attendance_status: 'pending' | 'present' | 'absent' | string | null;
  starts_at: string;
  ends_at: string | null;
  session_status: string | null;
  event_name: string | null;
  center_name: string | null;
  space_name: string | null;
  trainer_name: string | null;
  professional_service_name: string | null;
}

export interface MemberBookingsResponse {
  upcoming: MemberBooking[];
  past: MemberBooking[];
}

/**
 * The booking's own status label: the attendance once it was recorded on a
 * booked place (Present / Absent), else the booking status itself.
 */
export function bookingStatusKey(b: Pick<MemberBooking, 'status' | 'attendance_status'>): string {
  if (b.status === 'booked' && b.attendance_status === 'present') return 'calendar.attendance_present';
  if (b.status === 'booked' && b.attendance_status === 'absent') return 'calendar.attendance_absent';
  if (b.status === 'booked' || b.status === 'waitlisted' || b.status === 'cancelled') {
    return `members.booking_status_${b.status}`;
  }
  return 'members.booking_status_unknown';
}

/** A second line beside the status when the gym cancelled the event itself. */
export function eventCancelled(b: Pick<MemberBooking, 'session_status'>): boolean {
  return b.session_status === 'cancelled';
}

/** Center · Space, whichever exist; `null` renders `—`. */
export function bookingLocation(b: Pick<MemberBooking, 'center_name' | 'space_name'>): string | null {
  const parts = [b.center_name, b.space_name].map((p) => p?.trim()).filter((p): p is string => !!p);
  return parts.length ? parts.join(' · ') : null;
}

/** #2731 — `GET /members/:id/bookings?scope=upcoming`: the Upcoming list alone. */
export interface MemberUpcomingBookingsResponse {
  upcoming: MemberBooking[];
}

export interface PastBookingOption {
  id: number;
  name: string | null;
}

/** The status values the API's Status filter accepts (`PAST_BOOKING_STATUS_FILTERS`). */
export type PastBookingStatusFilter = 'booked' | 'present' | 'absent' | 'waitlisted' | 'cancelled';

/** #2731 — `GET /members/:id/bookings/past`: one page of the filtered history. */
export interface PastBookingsPage {
  rows: MemberBooking[];
  total: number;
  page: number;
  page_size: number;
  options: {
    activities: PastBookingOption[];
    centers: PastBookingOption[];
    trainers: PastBookingOption[];
    professional_services: PastBookingOption[];
    statuses: PastBookingStatusFilter[];
  };
}

/** The five filters of the Past Events section; `''` is "any". */
export interface PastBookingFilters {
  activity_type_id: string;
  center_id: string;
  trainer_membership_id: string;
  status: string;
  professional_service_id: string;
}

export const EMPTY_PAST_BOOKING_FILTERS: PastBookingFilters = {
  activity_type_id: '', center_id: '', trainer_membership_id: '', status: '', professional_service_id: '',
};

export function hasPastBookingFilters(f: PastBookingFilters): boolean {
  return Object.values(f).some((v) => v !== '');
}

/** The query string of one page: every chosen filter, combined, plus the page. */
export function pastBookingsQuery(f: PastBookingFilters, page: number): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== '') params.set(k, v);
  params.set('page', String(page));
  return params.toString();
}

/** How many pages `total` rows take (at least one, so "Page 1 of 1" on an empty list). */
export function pastBookingsPageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
}

/** The Status filter's label key for one value, the same words the Status column uses. */
export function pastStatusFilterKey(s: PastBookingStatusFilter | string): string {
  if (s === 'present') return 'calendar.attendance_present';
  if (s === 'absent') return 'calendar.attendance_absent';
  return bookingStatusKey({ status: s, attendance_status: null });
}
