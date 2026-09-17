import { describe, expect, it } from 'vitest';
import { DEFAULT_STATUS_COLOR, getCalendarEventStatusColor } from '../lib/calendarEventColors';

// #541 — status-based calendar event colors. Verifies the centralized
// mapping used by both plain calendar events (which can be `draft`, per
// EVENT_STATUSES in api/src/api/calendar-events.ts) and class sessions
// (SESSION_STATUSES — never `draft`).

describe('getCalendarEventStatusColor', () => {
  it('returns a distinct color for scheduled vs cancelled', () => {
    const scheduled = getCalendarEventStatusColor('scheduled');
    const cancelled = getCalendarEventStatusColor('cancelled');
    expect(scheduled).not.toBe(cancelled);
  });

  it('keeps the pre-existing purple for scheduled', () => {
    expect(getCalendarEventStatusColor('scheduled')).toBe('#6c63ff');
  });

  it('returns a distinct color for every supported status', () => {
    const statuses = ['scheduled', 'cancelled', 'completed', 'draft'];
    const colors = statuses.map((s) => getCalendarEventStatusColor(s));
    expect(new Set(colors).size).toBe(statuses.length);
  });

  it('is deterministic — same status always maps to the same color', () => {
    expect(getCalendarEventStatusColor('completed')).toBe(getCalendarEventStatusColor('completed'));
  });

  it('falls back to a safe default for unknown, null, or missing statuses', () => {
    expect(getCalendarEventStatusColor('some_future_status')).toBe(DEFAULT_STATUS_COLOR);
    expect(getCalendarEventStatusColor(null)).toBe(DEFAULT_STATUS_COLOR);
    expect(getCalendarEventStatusColor(undefined)).toBe(DEFAULT_STATUS_COLOR);
    expect(getCalendarEventStatusColor('')).toBe(DEFAULT_STATUS_COLOR);
  });
});
