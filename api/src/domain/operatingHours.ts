/**
 * #418: pure resolution logic for Operating Hours & Holidays.
 *
 * Holidays always take precedence over the recurring weekly schedule for the
 * dates they cover. If a gym has configured no weekly hours at all, the
 * feature is treated as "not set up yet" and every date resolves as
 * unrestricted (open) — existing gyms shouldn't suddenly see their whole
 * calendar greyed out the moment this ships.
 */

export interface WeeklyHoursRow {
  weekday: number; // 0=Sun..6=Sat
  start_time: string; // 'HH:MM' or 'HH:MM:SS'
  end_time: string;
}

export interface HolidayRow {
  date_start: string; // 'YYYY-MM-DD'
  date_end: string;
  start_time: string | null;
  end_time: string | null;
  is_closed: boolean;
  annual_renewal: boolean;
}

export interface TimeWindow {
  start_time: string; // 'HH:MM'
  end_time: string;
}

export interface EffectiveHoursForDate {
  /** true when the gym is fully closed on this date (either an is_closed holiday, or no weekly hours defined for this weekday and no override). */
  closed: boolean;
  /** Open windows for the date, e.g. [{start_time:'09:00',end_time:'14:00'}, {start_time:'15:00',end_time:'20:00'}]. Empty when closed. */
  windows: TimeWindow[];
  /** true when an override (non-annual-renewal or annual-renewal holiday) — as opposed to the plain weekly schedule — determined the result. */
  isHolidayOverride: boolean;
}

function truncateTime(t: string): string {
  return t.length > 5 ? t.slice(0, 5) : t;
}

function parseISODate(dateStr: string): { year: number; month: number; day: number } {
  const [year, month, day] = dateStr.slice(0, 10).split('-').map(Number);
  return { year, month, day };
}

/** Shifts a holiday's [date_start, date_end] range onto `year`, preserving month/day and the range's day-span (used for annual_renewal matching). */
function shiftRangeToYear(dateStart: string, dateEnd: string, year: number): { start: Date; end: Date } {
  const s = parseISODate(dateStart);
  const e = parseISODate(dateEnd);
  const startUTC = Date.UTC(s.year, s.month - 1, s.day);
  const endUTC = Date.UTC(e.year, e.month - 1, e.day);
  const spanDays = Math.round((endUTC - startUTC) / 86_400_000);
  const shiftedStart = new Date(Date.UTC(year, s.month - 1, s.day));
  const shiftedEnd = new Date(shiftedStart.getTime() + spanDays * 86_400_000);
  return { start: shiftedStart, end: shiftedEnd };
}

function dateOnlyUTC(dateStr: string): Date {
  const { year, month, day } = parseISODate(dateStr);
  return new Date(Date.UTC(year, month - 1, day));
}

function holidayMatchesDate(holiday: HolidayRow, targetDate: string): boolean {
  const target = dateOnlyUTC(targetDate);
  if (!holiday.annual_renewal) {
    const start = dateOnlyUTC(holiday.date_start);
    const end = dateOnlyUTC(holiday.date_end);
    return target >= start && target <= end;
  }
  const { year } = parseISODate(targetDate);
  // A holiday spanning e.g. Dec 30 - Jan 2 could match against either the
  // shift for `year` or `year - 1` depending on which side of new year's the
  // target falls on — check both.
  for (const y of [year, year - 1, year + 1]) {
    const { start, end } = shiftRangeToYear(holiday.date_start, holiday.date_end, y);
    if (target >= start && target <= end) return true;
  }
  return false;
}

/**
 * Resolves the effective open windows for a single calendar date.
 * `weekday` is 0 (Sun) .. 6 (Sat), matching JS Date#getDay() / the DB convention.
 */
export function resolveEffectiveHours(
  weeklyHours: WeeklyHoursRow[],
  holidays: HolidayRow[],
  targetDate: string,
  weekday: number,
): EffectiveHoursForDate {
  const holiday = holidays.find((h) => holidayMatchesDate(h, targetDate));
  if (holiday) {
    if (holiday.is_closed) return { closed: true, windows: [], isHolidayOverride: true };
    return {
      closed: false,
      windows: [{ start_time: truncateTime(holiday.start_time!), end_time: truncateTime(holiday.end_time!) }],
      isHolidayOverride: true,
    };
  }

  if (weeklyHours.length === 0) {
    // Feature not configured for this gym yet — don't restrict anything.
    return { closed: false, windows: [], isHolidayOverride: false };
  }

  const dayWindows = weeklyHours
    .filter((w) => w.weekday === weekday)
    .map((w) => ({ start_time: truncateTime(w.start_time), end_time: truncateTime(w.end_time) }))
    .sort((a, b) => a.start_time.localeCompare(b.start_time));

  return { closed: dayWindows.length === 0, windows: dayWindows, isHolidayOverride: false };
}

/** True when weeklyHours is non-empty, i.e. the gym has configured this feature at all. */
export function isConfigured(weeklyHours: WeeklyHoursRow[]): boolean {
  return weeklyHours.length > 0;
}
