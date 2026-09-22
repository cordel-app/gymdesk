import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STATUS_BADGE_COLORS,
  getCalendarEventStatusBadgeColors,
} from '../lib/calendarEventColors';

// #541 / #559 stage 3 — status-based calendar event colors. Verifies the
// centralized mapping used by both plain calendar events (which can be
// `draft`, per EVENT_STATUSES in api/src/api/calendar-events.ts) and class
// sessions (SESSION_STATUSES — never `draft`), plus the UI-derived `full`.
//
// Since stage 3 the color paints the pill badge inside the event rather than
// the event box, but the rule #541 set is unchanged: status, and nothing else,
// decides it.

describe('getCalendarEventStatusBadgeColors', () => {
  it('returns a distinct color for scheduled vs cancelled', () => {
    expect(getCalendarEventStatusBadgeColors('scheduled'))
      .not.toEqual(getCalendarEventStatusBadgeColors('cancelled'));
  });

  it('returns a distinct color for every supported status, `full` included', () => {
    const statuses = ['scheduled', 'cancelled', 'completed', 'draft', 'full'];
    const colors = statuses.map((s) => JSON.stringify(getCalendarEventStatusBadgeColors(s)));
    expect(new Set(colors).size).toBe(statuses.length);
  });

  it('is deterministic — same status always maps to the same color', () => {
    expect(getCalendarEventStatusBadgeColors('completed'))
      .toEqual(getCalendarEventStatusBadgeColors('completed'));
  });

  it('gives every status a hex background and a hex label color', () => {
    for (const status of ['scheduled', 'cancelled', 'completed', 'draft', 'full', 'unknown']) {
      const { bg, fg } = getCalendarEventStatusBadgeColors(status);
      expect(bg, `${status} has no valid background`).toMatch(/^#[0-9a-f]{6}$/i);
      expect(fg, `${status} has no valid label color`).toMatch(/^#[0-9a-f]{6}$/i);
      expect(bg, `${status}'s label is invisible on its own background`).not.toBe(fg);
    }
  });

  it('falls back to a safe default for unknown, null, or missing statuses', () => {
    expect(getCalendarEventStatusBadgeColors('some_future_status')).toEqual(DEFAULT_STATUS_BADGE_COLORS);
    expect(getCalendarEventStatusBadgeColors(null)).toEqual(DEFAULT_STATUS_BADGE_COLORS);
    expect(getCalendarEventStatusBadgeColors(undefined)).toEqual(DEFAULT_STATUS_BADGE_COLORS);
    expect(getCalendarEventStatusBadgeColors('')).toEqual(DEFAULT_STATUS_BADGE_COLORS);
  });
});
