/**
 * #2686: the Booking Access line of an Activity's read-only view. Private
 * (#2558: not a Public Event and no Professional Service named) reads as a
 * private event, not as "restricted by Professional Service". The API's
 * `domain/privateEventVisibility.ts` decides the same thing for visibility.
 *
 * `services` is undefined while the Activity's list has not loaded yet, which
 * answers `null` (render `—`) rather than guessing Private.
 */
export type BookingAccessLabelKey = 'public_event_yes' | 'public_event_no' | 'public_event_private';

export function bookingAccessLabelKey(publicEvent: boolean, services: readonly unknown[] | undefined): BookingAccessLabelKey | null {
  if (publicEvent) return 'public_event_yes';
  if (services === undefined) return null;
  return services.length === 0 ? 'public_event_private' : 'public_event_no';
}
