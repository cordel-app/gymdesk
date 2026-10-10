// #1370 stage 1 — what "done" may be claimed for, and how My Training counts
// progress. Pure: no DB, no HTTP. Dates are `YYYY-MM-DD` strings in the gym's
// time zone (#1246); weekday is 0=Sunday … 6=Saturday.
import { DateTime } from 'luxon';

export const FUTURE_WORKOUT_CODE = 'workout_in_future';

export function gymToday(now: Date, timeZone: string): string {
  const d = DateTime.fromJSDate(now, { zone: timeZone });
  return (d.isValid ? d : DateTime.fromJSDate(now, { zone: 'UTC' })).toISODate() as string;
}

/** A workout cannot be marked done for a date after today in the gym's zone. */
export function isFutureLoggedDate(loggedDate: string, now: Date, timeZone: string): boolean {
  return String(loggedDate).slice(0, 10) > gymToday(now, timeZone);
}

export interface WorkoutDef { id: number; weekday: number | null; blockIds: number[] }
export interface Completed { blockId: number; date: string }
export interface ProgressCounts { completed: number; total: number; percent: number }
export interface TrainingProgress { day: ProgressCounts; week: ProgressCounts; month: ProgressCounts }

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
  firstDayOfWeek = 1,
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
  const t = DateTime.fromISO(today, { zone: 'UTC' });
  const back = (((t.weekday % 7) - firstDayOfWeek) + 7) % 7;
  return {
    day: range(today, today),
    week: range(t.minus({ days: back }).toISODate()!, today),
    month: range(t.startOf('month').toISODate()!, today),
  };
}
