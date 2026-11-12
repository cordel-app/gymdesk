/**
 * #2664 — a Professional Service's Booking Type: whether the participants of one
 * booking must belong to the same family (`family_only`) or may come from
 * different families (`open_group`).
 *
 * #2674: a `family_only` service whose minimum is above one is booked as a
 * family group (`domain/familyGroupBooking.ts`). The set is mirrored by
 * `chk_professional_services_booking_type` (migration 403) and, for the admin
 * select, by `apps/admin/src/components/professionalServices/psModel.ts`, so a new
 * value goes in three places.
 */

export const SERVICE_BOOKING_TYPES = ['family_only', 'open_group'] as const;
export type ServiceBookingType = (typeof SERVICE_BOOKING_TYPES)[number];

/**
 * What every existing service and every service created without naming one
 * holds: `open_group` places no family restriction, so storing it changes
 * nothing about who may book a service.
 */
export const DEFAULT_SERVICE_BOOKING_TYPE: ServiceBookingType = 'open_group';

export function isServiceBookingType(value: unknown): value is ServiceBookingType {
  return typeof value === 'string' && (SERVICE_BOOKING_TYPES as readonly string[]).includes(value);
}

/**
 * Judges a request's `booking_type` once it is mentioned (the caller keeps the
 * stored value when the field is absent). The property is required, so `null`,
 * `''` and any unknown value are a 400 — never coerced onto a valid value.
 */
export function parseServiceBookingType(value: unknown): { value: ServiceBookingType } | { error: string } {
  if (isServiceBookingType(value)) return { value };
  return { error: `booking_type must be one of: ${SERVICE_BOOKING_TYPES.join(', ')}` };
}
