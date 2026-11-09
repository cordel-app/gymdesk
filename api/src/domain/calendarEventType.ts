/**
 * #2559: the type of a manually created calendar event. Mirrored by
 * `chk_calendar_events_event_type` (migration 379) and by the Admin form.
 * `professional_services` carries a list of eligible Professional Services and
 * no capacity; the other two carry a capacity.
 */
export const CALENDAR_EVENT_TYPES = ['public', 'private', 'professional_services'] as const;
export type CalendarEventType = (typeof CALENDAR_EVENT_TYPES)[number];

export function parseCalendarEventType(value: unknown): { type: CalendarEventType | null } | { error: string } {
  if (value === undefined || value === null || value === '') return { type: null };
  if (typeof value === 'string' && (CALENDAR_EVENT_TYPES as readonly string[]).includes(value)) {
    return { type: value as CalendarEventType };
  }
  return { error: `event_type must be one of: ${CALENDAR_EVENT_TYPES.join(', ')}` };
}

/** A positive integer capacity, or null for none. */
export function parseEventCapacity(value: unknown): { capacity: number | null } | { error: string } {
  if (value === undefined || value === null || value === '') return { capacity: null };
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return { error: 'capacity must be a positive integer' };
  return { capacity: n };
}

/** The service ids of a Professional Services Based event: positive integers, de-duplicated. */
export function parseEventServiceIds(value: unknown): { ids: number[] } | { error: string } {
  if (value === undefined || value === null) return { ids: [] };
  if (!Array.isArray(value)) return { error: 'eligible_professional_service_ids must be an array' };
  const ids: number[] = [];
  for (const v of value) {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) return { error: 'eligible_professional_service_ids must be positive integers' };
    if (!ids.includes(n)) ids.push(n);
  }
  return { ids };
}
