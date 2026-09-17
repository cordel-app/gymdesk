// Centralized status -> color mapping for calendar events (#541).
// Color must depend only on `calendar_events.status` — never on activity,
// activity type, trainer, room, source, booking count, or capacity.
// Kept in sync with the DB statuses in api/src/api/calendar-events.ts
// (SESSION_STATUSES / EVENT_STATUSES): draft is event-only, sessions never
// use it, but the mapping covers every value from either set plus a
// fallback for anything unrecognized.

export type CalendarEventStatus = 'draft' | 'scheduled' | 'completed' | 'cancelled';

const STATUS_COLORS: Record<CalendarEventStatus, string> = {
  scheduled: '#6c63ff', // unchanged from the prior default purple
  cancelled: '#c0392b',
  completed: '#1e7e40',
  draft:     '#5a6b7b',
};

export const DEFAULT_STATUS_COLOR = '#6b7280';

export function getCalendarEventStatusColor(status: string | null | undefined): string {
  if (status && Object.prototype.hasOwnProperty.call(STATUS_COLORS, status)) {
    return STATUS_COLORS[status as CalendarEventStatus];
  }
  return DEFAULT_STATUS_COLOR;
}
