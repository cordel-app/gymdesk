/**
 * #2686: a Private event is not visible in the Members App, and not
 * self-bookable, unless a Staff member added that Member to it.
 *
 * This module is the one place that decides what "private" means for an
 * occurrence, in TypeScript and in SQL:
 *
 *   - a manually created calendar event whose `event_type` is `private`
 *     (#2559). A manual event's own type always decides, whatever Activity it
 *     may name;
 *   - an Activity occurrence whose Activity Type is **Private** (#2558: not a
 *     Public Event and names no Professional Service), unless the occurrence
 *     carries its own eligible-services list (#980 stage 3,
 *     `eligible_services_override = 1`), which is then what governs it.
 *
 * "Added by Staff" is a booking row that is not `cancelled`: staff add a
 * Member through `POST /bookings` from the Activity view or the Calendar view,
 * and a Member can never create such a row on a private occurrence themselves
 * (`POST /me/bookings` refuses). No second assignment record exists.
 */

export interface OccurrencePrivacyInput {
  /** `calendar_events.event_type` — set only on manually created events. */
  eventType: string | null;
  /** `calendar_events.activity_type_id`. */
  activityTypeId: number | null;
  /** `activity_types.public_event`. */
  publicEvent: boolean | null;
  /** How many live Professional Services the Activity Type names. */
  activityServiceCount: number;
  /** `calendar_events.eligible_services_override`. */
  eligibleServicesOverride: boolean;
}

export function isPrivateOccurrence(input: OccurrencePrivacyInput): boolean {
  if (input.eventType != null) return input.eventType === 'private';
  if (input.activityTypeId == null) return false;
  if (input.publicEvent !== false) return false;
  if (input.eligibleServicesOverride) return false;
  return input.activityServiceCount === 0;
}

/** Is an Activity Type itself Private (#2558)? Read for the Admin's Booking Access label. */
export function isPrivateActivityType(publicEvent: boolean, activityServiceCount: number): boolean {
  return !publicEvent && activityServiceCount === 0;
}

/**
 * The SQL spelling of `isPrivateOccurrence()` for an occurrence aliased `ce`
 * whose Activity Type is LEFT JOINed as `at`. Evaluates to 1 or 0.
 */
export function privateOccurrenceSql(ce = 'ce', at = 'at'): string {
  return `(CASE
      WHEN ${ce}.event_type IS NOT NULL THEN ${ce}.event_type = 'private'
      WHEN ${ce}.activity_type_id IS NULL THEN 0
      WHEN COALESCE(${at}.public_event, 1) = 1 THEN 0
      WHEN ${ce}.eligible_services_override = 1 THEN 0
      ELSE NOT EXISTS (
        SELECT 1 FROM activity_type_eligible_professional_services pv_ateps
        JOIN professional_services pv_ps ON pv_ps.id = pv_ateps.professional_service_id AND pv_ps.deleted_at IS NULL
        WHERE pv_ateps.activity_type_id = ${ce}.activity_type_id AND pv_ateps.gym_id = ${ce}.gym_id
      )
    END)`;
}

/**
 * The member-facing visibility predicate: an occurrence that is not private,
 * or one the member (bound as the single `?`) holds a live booking row on.
 */
export function memberCanSeeOccurrenceSql(ce = 'ce', at = 'at'): string {
  return `(${privateOccurrenceSql(ce, at)} = 0 OR EXISTS (
      SELECT 1 FROM calendar_event_bookings pv_b
      WHERE pv_b.calendar_event_id = ${ce}.id AND pv_b.member_id = ? AND pv_b.status <> 'cancelled'))`;
}

export const PRIVATE_EVENT_CODE = 'private_event';
