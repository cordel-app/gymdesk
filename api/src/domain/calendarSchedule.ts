/**
 * #2125 M5c — the billing calendar a schedule is anchored on (Oscar, 2026-11-11,
 * Option B):
 *
 *   - **Monthly** (`1 month`): the 1st of every calendar month.
 *   - **Every 4 weeks** (`4 week`): the fixed 28-day grid anchored on Monday
 *     2026-11-02 (`FOUR_WEEK_GRID_EPOCH`), extended backwards and forwards.
 *   - **Weekly** (`1 week`): every Monday.
 *   - **Yearly** (`1 year`) and any other stored cadence: the obligation's own
 *     date (its contract anniversary) — nothing is moved.
 *
 * `calendarAnchorOnOrBefore()` is the one place that answers which grid date a
 * schedule is anchored on: the last grid date on or before the day the schedule
 * was first needed. Anchoring *on or before* is what lets `nextAlignedDate()`
 * (`billingSimulation.ts`) find the next grid date after a start that falls
 * between two of them, so the start pays a prorated first stretch (#2125 stage
 * 8's mechanism) and every later charge falls on the grid.
 *
 * Pure: no database, no clock. Dates are `YYYY-MM-DD`, computed in UTC.
 */

export interface CalendarCadence { interval: number; unit: string }

export const FOUR_WEEK_GRID_EPOCH = '2026-11-02';

const DAY_MS = 86_400_000;

function toUtc(date: string): number {
  const [y, m, d] = date.slice(0, 10).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Which grid a cadence bills on, or `null` when it keeps its own anniversary. */
export function calendarGridOf(cadence: CalendarCadence): 'month_start' | 'four_week' | 'monday' | null {
  const interval = Number(cadence.interval);
  if (interval === 1 && cadence.unit === 'month') return 'month_start';
  if (interval === 4 && cadence.unit === 'week') return 'four_week';
  if (interval === 1 && cadence.unit === 'week') return 'monday';
  return null;
}

/** The last grid date of `cadence` on or before `date`; `date` itself for a cadence with no grid. */
export function calendarAnchorOnOrBefore(cadence: CalendarCadence, date: string): string {
  const day = date.slice(0, 10);
  switch (calendarGridOf(cadence)) {
    case 'month_start':
      return `${day.slice(0, 8)}01`;
    case 'monday': {
      const ms = toUtc(day);
      const weekday = new Date(ms).getUTCDay(); // 0 = Sunday … 6 = Saturday
      const back = (weekday + 6) % 7; // days since the last Monday
      return fromUtc(ms - back * DAY_MS);
    }
    case 'four_week': {
      const diffDays = Math.round((toUtc(day) - toUtc(FOUR_WEEK_GRID_EPOCH)) / DAY_MS);
      const steps = Math.floor(diffDays / 28);
      return fromUtc(toUtc(FOUR_WEEK_GRID_EPOCH) + steps * 28 * DAY_MS);
    }
    default:
      return day;
  }
}

/** Whether `date` is itself a date of `cadence`'s grid (always true for a cadence with no grid). */
export function isOnCalendarGrid(cadence: CalendarCadence, date: string): boolean {
  return calendarAnchorOnOrBefore(cadence, date) === date.slice(0, 10);
}
