// Unit tests for resolveEffectiveHours — pure function, no DB dependency.
// #418: holidays always override the weekly schedule for the dates they
// cover, annual_renewal holidays are matched by month/day every year, and an
// unconfigured gym (no weekly rows at all) is treated as unrestricted.

import { describe, expect, it } from 'vitest';
import { resolveEffectiveHours, isConfigured, type WeeklyHoursRow, type HolidayRow } from '../domain/operatingHours';

const WEEKLY: WeeklyHoursRow[] = [
  // Monday split shift
  { weekday: 1, start_time: '09:00', end_time: '14:00' },
  { weekday: 1, start_time: '15:00', end_time: '20:00' },
  // Saturday single shift
  { weekday: 6, start_time: '10:00', end_time: '13:00' },
];

function holiday(overrides: Partial<HolidayRow>): HolidayRow {
  return {
    date_start: '2026-12-31',
    date_end: '2026-12-31',
    start_time: null,
    end_time: null,
    is_closed: true,
    annual_renewal: false,
    ...overrides,
  };
}

describe('resolveEffectiveHours', () => {
  it('returns the weekly split-shift windows for a normal Monday', () => {
    const result = resolveEffectiveHours(WEEKLY, [], '2026-09-07', 1);
    expect(result.closed).toBe(false);
    expect(result.isHolidayOverride).toBe(false);
    expect(result.windows).toEqual([
      { start_time: '09:00', end_time: '14:00' },
      { start_time: '15:00', end_time: '20:00' },
    ]);
  });

  it('treats a weekday with no configured shifts as closed once the feature is configured', () => {
    // Sunday (0) has no rows in WEEKLY.
    const result = resolveEffectiveHours(WEEKLY, [], '2026-09-06', 0);
    expect(result.closed).toBe(true);
    expect(result.windows).toEqual([]);
  });

  it('treats every date as unrestricted when no weekly hours are configured at all', () => {
    const result = resolveEffectiveHours([], [], '2026-09-06', 0);
    expect(result.closed).toBe(false);
    expect(result.windows).toEqual([]);
    expect(isConfigured([])).toBe(false);
  });

  it('a full-closure holiday overrides an otherwise-open weekday', () => {
    const holidays = [holiday({ date_start: '2026-09-07', date_end: '2026-09-07', is_closed: true })];
    const result = resolveEffectiveHours(WEEKLY, holidays, '2026-09-07', 1);
    expect(result.closed).toBe(true);
    expect(result.isHolidayOverride).toBe(true);
  });

  it('a special-hours holiday overrides the weekly schedule with its own single window', () => {
    const holidays = [holiday({
      date_start: '2026-09-07', date_end: '2026-09-07',
      is_closed: false, start_time: '08:00', end_time: '10:00',
    })];
    const result = resolveEffectiveHours(WEEKLY, holidays, '2026-09-07', 1);
    expect(result.closed).toBe(false);
    expect(result.isHolidayOverride).toBe(true);
    expect(result.windows).toEqual([{ start_time: '08:00', end_time: '10:00' }]);
  });

  it('a date-range holiday covers every day in [date_start, date_end]', () => {
    const holidays = [holiday({ date_start: '2026-12-24', date_end: '2026-12-26', is_closed: true })];
    expect(resolveEffectiveHours(WEEKLY, holidays, '2026-12-24', 4).closed).toBe(true);
    expect(resolveEffectiveHours(WEEKLY, holidays, '2026-12-25', 5).closed).toBe(true);
    expect(resolveEffectiveHours(WEEKLY, holidays, '2026-12-26', 6).closed).toBe(true);
    // Day after the holiday range: no longer holiday-covered, falls back to the
    // weekly schedule — Sunday has no configured shifts, so still closed.
    const dayAfter = resolveEffectiveHours(WEEKLY, holidays, '2026-12-27', 0);
    expect(dayAfter.isHolidayOverride).toBe(false);
    expect(dayAfter.closed).toBe(true);
  });

  it('an annual_renewal holiday matches the same month/day in a different year', () => {
    const holidays = [holiday({ date_start: '2020-12-31', date_end: '2020-12-31', is_closed: true, annual_renewal: true })];
    expect(resolveEffectiveHours(WEEKLY, holidays, '2026-12-31', 4).closed).toBe(true);
    expect(resolveEffectiveHours(WEEKLY, holidays, '2027-12-31', 5).closed).toBe(true);
    // A different date entirely does not match.
    const notHoliday = resolveEffectiveHours(WEEKLY, holidays, '2026-12-30', 3);
    expect(notHoliday.isHolidayOverride).toBe(false);
  });

  it('a non-annual holiday does not match a different year', () => {
    const holidays = [holiday({ date_start: '2026-12-31', date_end: '2026-12-31', is_closed: true, annual_renewal: false })];
    const result = resolveEffectiveHours(WEEKLY, holidays, '2027-12-31', 5);
    expect(result.isHolidayOverride).toBe(false);
  });

  it('an annual_renewal multi-day range preserves its day-span across years', () => {
    const holidays = [holiday({ date_start: '2020-12-24', date_end: '2020-12-26', is_closed: true, annual_renewal: true })];
    expect(resolveEffectiveHours(WEEKLY, holidays, '2026-12-24', 4).closed).toBe(true);
    expect(resolveEffectiveHours(WEEKLY, holidays, '2026-12-25', 5).closed).toBe(true);
    expect(resolveEffectiveHours(WEEKLY, holidays, '2026-12-26', 6).closed).toBe(true);
    expect(resolveEffectiveHours(WEEKLY, holidays, '2026-12-27', 0).isHolidayOverride).toBe(false);
  });
});
