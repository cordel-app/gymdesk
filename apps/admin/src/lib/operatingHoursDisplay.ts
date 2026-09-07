/**
 * #418: turns the raw Operating Hours & Holidays API data into what
 * FullCalendar needs to grey out out-of-hours/closed periods — a
 * `businessHours` config for the recurring weekly schedule, plus background
 * events for holiday exceptions (which always override the weekly schedule
 * for the dates they cover, including projecting an annual_renewal holiday
 * onto whichever years the visible calendar range touches).
 */

export interface WeeklyShiftDTO {
  weekday: number; // 0=Sun..6=Sat
  start_time: string;
  end_time: string;
}

export interface HolidayDTO {
  date_start: string;
  date_end: string;
  start_time: string | null;
  end_time: string | null;
  is_closed: number | boolean;
  annual_renewal: number | boolean;
}

export interface BackgroundEvent {
  start: string;
  end: string;
  display: 'background';
  color: string;
  classNames: string[];
}

/** Grey used for closed/out-of-hours background blocks — set directly (not via CSS) since these apps have no global stylesheet. */
const CLOSED_COLOR = '#9ca3af';

export function weeklyToBusinessHours(weekly: WeeklyShiftDTO[]) {
  return weekly.map((s) => ({
    daysOfWeek: [s.weekday],
    startTime: s.start_time.slice(0, 5),
    endTime: s.end_time.slice(0, 5),
  }));
}

function parseDateOnly(d: string): Date {
  const [y, m, day] = d.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, day);
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Expands a holiday row into concrete [start, end) date instances overlapping [rangeStart, rangeEnd), projecting annual_renewal rows onto every year the range touches. */
function expandHolidayInstances(h: HolidayDTO, rangeStart: Date, rangeEnd: Date): { start: Date; end: Date }[] {
  const baseStart = parseDateOnly(h.date_start);
  const baseEnd = parseDateOnly(h.date_end);
  const spanDays = Math.round((baseEnd.getTime() - baseStart.getTime()) / 86_400_000);
  const annual = h.annual_renewal === true || h.annual_renewal === 1;

  if (!annual) {
    const start = baseStart;
    const end = addDays(baseEnd, 1); // exclusive
    return start < rangeEnd && end > rangeStart ? [{ start, end }] : [];
  }

  const years = new Set([rangeStart.getFullYear() - 1, rangeStart.getFullYear(), rangeEnd.getFullYear(), rangeEnd.getFullYear() + 1]);
  const instances: { start: Date; end: Date }[] = [];
  for (const year of years) {
    const shiftedStart = new Date(year, baseStart.getMonth(), baseStart.getDate());
    const shiftedEnd = addDays(shiftedStart, spanDays + 1); // exclusive
    if (shiftedStart < rangeEnd && shiftedEnd > rangeStart) instances.push({ start: shiftedStart, end: shiftedEnd });
  }
  return instances;
}

/**
 * Background events greying out closed/out-of-hours periods introduced by
 * holiday exceptions: full closures grey the whole day(s); special hours
 * grey everything on that day outside [start_time, end_time).
 */
export function holidayBackgroundEvents(holidays: HolidayDTO[], rangeStart: Date, rangeEnd: Date): BackgroundEvent[] {
  const events: BackgroundEvent[] = [];

  for (const h of holidays) {
    const closed = h.is_closed === true || h.is_closed === 1;
    for (const { start, end } of expandHolidayInstances(h, rangeStart, rangeEnd)) {
      if (closed) {
        events.push({ start: isoDate(start), end: isoDate(end), display: 'background', color: CLOSED_COLOR, classNames: ['gd-hours-closed'] });
        continue;
      }
      const startTime = (h.start_time ?? '00:00').slice(0, 5);
      const endTime = (h.end_time ?? '23:59').slice(0, 5);
      for (let d = new Date(start); d < end; d = addDays(d, 1)) {
        const dayIso = isoDate(d);
        const nextIso = isoDate(addDays(d, 1));
        if (startTime > '00:00') {
          events.push({ start: `${dayIso}T00:00:00`, end: `${dayIso}T${startTime}:00`, display: 'background', color: CLOSED_COLOR, classNames: ['gd-hours-closed'] });
        }
        if (endTime < '23:59') {
          events.push({ start: `${dayIso}T${endTime}:00`, end: `${nextIso}T00:00:00`, display: 'background', color: CLOSED_COLOR, classNames: ['gd-hours-closed'] });
        }
      }
    }
  }
  return events;
}
