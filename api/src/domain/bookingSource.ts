/** #3090: how a calendar event was created. Mirrored by `chk_calendar_events_booking_source` (migration 446). */
export const BOOKING_SOURCES = ['manual', 'recurring_slot'] as const;
export type BookingSource = (typeof BOOKING_SOURCES)[number];

/** Events written by staff or by a member are `manual`; only the schedule generator writes `recurring_slot`. */
export const DEFAULT_BOOKING_SOURCE: BookingSource = 'manual';

export function isBookingSource(v: unknown): v is BookingSource {
  return typeof v === 'string' && (BOOKING_SOURCES as readonly string[]).includes(v);
}
