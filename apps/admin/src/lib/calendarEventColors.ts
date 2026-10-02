// Centralized status -> color mapping for calendar events (#541, #559 stage 3).
//
// Color must depend only on `calendar_events.status` — never on activity,
// activity type, trainer, room, source, booking count, or capacity. The one
// exception the UI adds on top is `full`, a *derived* status for a scheduled
// class session whose bookings reached capacity.
//
// #559 stage 3 moved where this color is painted, not what drives it: the
// event box itself is now the theme's Calendar event background (one color for
// every event, configurable in Base/Custom Themes), and the status is carried
// by a pill-shaped badge inside the event that uses the palette below. Status
// therefore still determines a color, and only status does.
//
// Kept in sync with the DB statuses in api/src/api/calendar-events.ts
// (SESSION_STATUSES / EVENT_STATUSES): draft is event-only, sessions never
// use it, but the mapping covers every value from either set plus a
// fallback for anything unrecognized.

export type CalendarEventStatus = 'draft' | 'scheduled' | 'completed' | 'cancelled';

/**
 * The DB statuses plus the two derived ones the badge can also carry:
 * `full` (a scheduled session whose bookings reached capacity, derived in the
 * UI from booked_count/capacity) and `not_used` (#977 — a scheduled event that
 * ended with no bookings, derived *server-side* and reported as
 * `execution_status`; the page never re-derives it, so what the calendar shows
 * and what a report counts cannot disagree).
 */
export type CalendarEventBadgeStatus = CalendarEventStatus | 'full' | 'not_used';

export interface CalendarStatusBadgeColors {
  /** Pill background. */
  bg: string;
  /** Pill label color. */
  fg: string;
}

// Same palette the app's other status pills use (components/StatusBadge.tsx):
// a soft tint plus a darker label, which keeps the badge legible on top of any
// configured event background instead of competing with it.
//
// The one neutral tone in that palette, shared by the two statuses that are
// the absence of an outcome: a `draft` event nobody published, and a `not_used`
// slot nobody booked. #977 §8 forbids inventing a hue for the execution
// statuses unless it already exists in the app's status system — so `not_used`
// takes this pair rather than the yellow the ticket rules out, and
// `completed`/`cancelled`/`scheduled` keep the green/red/blue they have had
// since #541.
const NEUTRAL_BADGE_COLORS: CalendarStatusBadgeColors = { bg: '#eef2f7', fg: '#5a6b7b' };

const STATUS_BADGE_COLORS: Record<CalendarEventBadgeStatus, CalendarStatusBadgeColors> = {
  scheduled: { bg: '#e8f0fe', fg: '#1a56a8' },
  cancelled: { bg: '#fdeaea', fg: '#c0392b' },
  completed: { bg: '#e6f6ec', fg: '#1e7e40' },
  draft:     NEUTRAL_BADGE_COLORS,
  not_used:  NEUTRAL_BADGE_COLORS,
  full:      { bg: '#fff4e0', fg: '#b26a00' },
};

export const DEFAULT_STATUS_BADGE_COLORS: CalendarStatusBadgeColors = { bg: '#f0f0f0', fg: '#666666' };

export function getCalendarEventStatusBadgeColors(
  status: string | null | undefined,
): CalendarStatusBadgeColors {
  if (status && Object.prototype.hasOwnProperty.call(STATUS_BADGE_COLORS, status)) {
    return STATUS_BADGE_COLORS[status as CalendarEventBadgeStatus];
  }
  return DEFAULT_STATUS_BADGE_COLORS;
}
