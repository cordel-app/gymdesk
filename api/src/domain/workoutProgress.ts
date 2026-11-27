// #1370 stage 1 — what "done" may be claimed for, and how My Training counts
// progress. Pure: no DB, no HTTP. Dates are `YYYY-MM-DD` strings in the gym's
// time zone (#1246); weekday is 0=Sunday … 6=Saturday.
import { DateTime } from 'luxon';

export const ROLLING_WEEK_DAYS = 7;

/**
 * #3331 / #3401 — the month the third summary card of My Nutrition and My
 * Training reports: the calendar month of the selected date, from its 1st to
 * its last day, never past today. A month that has not started yet is an empty
 * range (from > to), which reads 0 %.
 */
export function calendarMonthRange(selected: string, today: string): [string, string] {
  const sel = DateTime.fromISO(selected, { zone: 'UTC' });
  const from = sel.startOf('month').toISODate() as string;
  const last = sel.endOf('month').toISODate() as string;
  return [from, last > today ? today : last];
}

export function gymToday(now: Date, timeZone: string): string {
  const d = DateTime.fromJSDate(now, { zone: timeZone });
  return (d.isValid ? d : DateTime.fromJSDate(now, { zone: 'UTC' })).toISODate() as string;
}

/**
 * #3494 — how much of a block a log claims. `done` (Fully Done) is the whole
 * contribution the old Mark done recorded, `partial` (Partially Done) exactly
 * half of it. Mirrored by `chk_workout_block_logs_level` (migration 496) and,
 * for the Members App, by `apps/member/src/lib/trainingDayStatus.ts`.
 */
export const BLOCK_COMPLETION_LEVELS = ['partial', 'done'] as const;
export type BlockCompletionLevel = (typeof BLOCK_COMPLETION_LEVELS)[number];
export const BLOCK_LEVEL_CREDIT: Record<BlockCompletionLevel, number> = { partial: 0.5, done: 1 };

/** Absent → `done` (what every pre-#3494 client means); anything but the two levels is an error string. */
export function parseBlockLevelInput(raw: unknown): BlockCompletionLevel | string {
  if (raw === undefined || raw === null) return 'done';
  return (BLOCK_COMPLETION_LEVELS as readonly unknown[]).includes(raw)
    ? (raw as BlockCompletionLevel)
    : `level must be one of: ${BLOCK_COMPLETION_LEVELS.join(', ')}`;
}

/** A log's credit; an unknown or missing level reads as a full completion (the column's default). */
export function blockCredit(level: unknown): number {
  return level === 'partial' ? BLOCK_LEVEL_CREDIT.partial : BLOCK_LEVEL_CREDIT.done;
}

export interface WorkoutDef {
  id: number;
  /** 0=Sunday … 6=Saturday; `null` = listed on every day (#1709). */
  weekday: number | null;
  blockIds: number[];
  /** The plan's own dates (`YYYY-MM-DD`); a day outside them lists no workout of it. */
  startDate?: string | null;
  endDate?: string | null;
}
export interface Completed { blockId: number; date: string; level?: string | null }
export interface ProgressCounts { completed: number; total: number; percent: number }
export interface TrainingProgress {
  /** The gym's today, so a client never derives it from the device clock. */
  today?: string; day: ProgressCounts; week: ProgressCounts; month: ProgressCounts }

function counts(completed: number, total: number): ProgressCounts {
  const c = Math.round(completed * 100) / 100;
  return { completed: c, total, percent: total === 0 ? 0 : Math.round((completed / total) * 100) };
}

function weekdayOf(date: string): number {
  return DateTime.fromISO(date, { zone: 'UTC' }).weekday % 7;
}

/** Whether a workout is listed on a date: its weekday or no weekday (#1709), inside its plan's dates. */
export function workoutListedOn(w: WorkoutDef, date: string): boolean {
  if (w.weekday !== null && w.weekday !== weekdayOf(date)) return false;
  if (w.startDate && date < String(w.startDate).slice(0, 10)) return false;
  if (w.endDate && date > String(w.endDate).slice(0, 10)) return false;
  return true;
}

/**
 * Each scheduled workout counts 1, and contributes the mean of its blocks'
 * credit that date (#3494): a block with no log 0, Partially Done 0.5, Fully
 * Done 1. Several logs of one block on one date never add up: the highest
 * level is what counts, so repeated clicks award nothing more (and
 * `POST /me/workout-block-logs` moves every log of that block and date to the
 * level chosen, so Fully Done → Partially Done lowers it). A workout with
 * every block Fully Done contributes exactly 1, which is the pre-#3494 rule.
 */
export function trainingProgress(
  workouts: WorkoutDef[],
  logs: Completed[],
  today: string,
  _firstDayOfWeek = 1,
  selected: string = today,
): TrainingProgress {
  const credit = new Map<string, number>();
  for (const l of logs) {
    const key = `${l.blockId}|${String(l.date).slice(0, 10)}`;
    credit.set(key, Math.max(credit.get(key) ?? 0, blockCredit(l.level)));
  }
  const workoutCredit = (w: WorkoutDef, date: string) => (w.blockIds.length === 0
    ? 0
    : w.blockIds.reduce((s, b) => s + (credit.get(`${b}|${date}`) ?? 0), 0) / w.blockIds.length);
  const range = (from: string, to: string): ProgressCounts => {
    let c = 0, t = 0;
    for (let d = DateTime.fromISO(from, { zone: 'UTC' }); d.toISODate()! <= to; d = d.plus({ days: 1 })) {
      const date = d.toISODate()!;
      for (const w of workouts) {
        if (!workoutListedOn(w, date)) continue;
        t++;
        c += workoutCredit(w, date);
      }
    }
    return counts(c, t);
  };
  // #1524: the week is a rolling 7 days ending on the selected date; #3401: the
  // month is the selected date's calendar month. Neither counts a day after today.
  const t = DateTime.fromISO(selected, { zone: 'UTC' });
  const end = selected > today ? today : selected;
  return {
    day: range(selected, selected),
    week: range(t.minus({ days: ROLLING_WEEK_DAYS - 1 }).toISODate()!, end),
    month: range(...calendarMonthRange(selected, today)),
  };
}
