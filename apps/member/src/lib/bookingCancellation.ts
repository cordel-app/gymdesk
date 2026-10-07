// #1162 — what the Members App says about a booking it cannot cancel, decided
// here and drawn by the three screens that offer a Cancel action (My Bookings,
// the Calendar's event sheet, the dashboard's My Next Bookings card).
//
// The rule itself is the API's (`api/src/domain/bookingCancellation.ts`) and is
// enforced on `DELETE /me/bookings/:id` (§9): every booking read reports
// `can_cancel` and, when it is false, which block applies, so this module
// never re-derives eligibility from dates — it only picks the locale **key**
// for the explanation (§5), which the page resolves. The wording differs for a
// booking linked to a Professional Service, and `professional_service` is the
// API's flag, never a guess from the activity's name.

export type CancellationBlock = 'already_started' | 'window_closed' | null;

export interface CancellableBooking {
  can_cancel: boolean;
  cancellation_block: CancellationBlock;
  professional_service: boolean;
}

export const CANCELLATION_NOTICE_TITLE_KEY = 'member_schedule.cancel_unavailable_title';

/** The *Booked on {date}* line (§6); the page formats the date in its own convention. */
export const BOOKED_ON_KEY = 'member_schedule.booked_on_detail';

/**
 * The explanation to show where the Cancel action would be — only for a
 * booking inside the notice window with its grace period spent. An event that
 * has already started gets no notice (the action is simply gone, as before),
 * and a cancellable booking gets the action.
 */
export function cancellationNoticeKey(booking: CancellableBooking): string | null {
  if (booking.can_cancel || booking.cancellation_block !== 'window_closed') return null;
  return booking.professional_service
    ? 'member_schedule.cancel_unavailable_service'
    : 'member_schedule.cancel_unavailable_generic';
}
