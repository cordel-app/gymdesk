// #2904 — a My Bookings event card that offers Professional Services keeps its
// booking controls (the service choices, the family participants and Book /
// Buy / Join waitlist) folded away until the member expands the card, so the
// list stays compact. Pure: no React. Expanding is presentation only — it
// fetches nothing and books or cancels nothing.

export interface BookingCardState {
  professional_services?: readonly unknown[] | null;
  my_booking_status?: string | null;
  access_locked?: boolean | null;
}

/**
 * Whether the card's booking controls fold behind its expand toggle: only a
 * card that offers a Professional Service and that the member can still book.
 * A booked or waitlisted card keeps its service and Cancel visible, and a
 * locked card has no controls to fold.
 */
export function bookingControlsCollapsible(s: BookingCardState): boolean {
  return (s.professional_services?.length ?? 0) > 0 && !s.my_booking_status && !s.access_locked;
}

/** Whether the booking controls are drawn: always, unless they fold and the card is closed. */
export function showBookingControls(s: BookingCardState, expanded: boolean): boolean {
  return expanded || !bookingControlsCollapsible(s);
}
