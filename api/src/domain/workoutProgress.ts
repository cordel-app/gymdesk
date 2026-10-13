// #1370 stage 1 — what "done" may be claimed for, and how My Training counts
// progress. Pure: no DB, no HTTP. Dates are `YYYY-MM-DD` strings in the gym's
// time zone (#1246); weekday is 0=Sunday … 6=Saturday.
import { DateTime } from 'luxon';

export const ROLLING_WEEK_DAYS = 7;
export const ROLLING_MONTH_DAYS = 30;

export function gymToday(now: Date, timeZone: string): string {
  const d = DateTime.fromJSDate(now, { zone: timeZone });
  return (d.isValid ? d : DateTime.fromJSDate(now, { zone: 'UTC' })).toISODate() as string;
}

export interface WorkoutDef { id: number; weekday: number | null; blockIds: number[] }
export interface Completed { blockId: number; date: string }
export interface ProgressCounts { completed: number; total: number; percent: number }
export interface TrainingProgress {
  /** The gym's today, so a client never derives it from the device clock. */
  today?: string; day: ProgressCounts; week: ProgressCounts; month: ProgressCounts }

function counts(completed: number, total: number): ProgressCounts {
  return { completed, total, percent: total === 0 ? 0 : Math.round((completed / total) * 100) };
}

function weekdayOf(date: string): number {
  return DateTime.fromISO(date, { zone: 'UTC' }).weekday % 7;
}

/** A scheduled workout is done on a date when every one of its blocks has a log that date. */
export function trainingProgress(
  workouts: WorkoutDef[],
  logs: Completed[],
  today: string,
  _firstDayOfWeek = 1,
  selected: string = today,
): TrainingProgress {
  const done = new Set(logs.map((l) => `${l.blockId}|${String(l.date).slice(0, 10)}`));
  const isDone = (w: WorkoutDef, date: string) =>
    w.blockIds.length > 0 && w.blockIds.every((b) => done.has(`${b}|${date}`));
  const range = (from: string, to: string): ProgressCounts => {
    let c = 0, t = 0;
    for (let d = DateTime.fromISO(from, { zone: 'UTC' }); d.toISODate()! <= to; d = d.plus({ days: 1 })) {
      const date = d.toISODate()!;
      for (const w of workouts) {
        if (w.weekday === null || w.weekday !== weekdayOf(date)) continue;
        t++;
        if (isDone(w, date)) c++;
      }
    }
    return counts(c, t);
  };
  // #1524: week and month are rolling windows (7 and 30 days) ending on the
  // selected date, and none of them counts a day after today.
  const t = DateTime.fromISO(selected, { zone: 'UTC' });
  const end = selected > today ? today : selected;
  return {
    day: range(selected, selected),
    week: range(t.minus({ days: ROLLING_WEEK_DAYS - 1 }).toISODate()!, end),
    month: range(t.minus({ days: ROLLING_MONTH_DAYS - 1 }).toISODate()!, end),
  };
}
