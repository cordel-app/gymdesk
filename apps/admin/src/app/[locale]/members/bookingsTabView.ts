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
