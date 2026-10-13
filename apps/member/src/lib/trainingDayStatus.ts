// #1527 — the status of each day in My Training's week card. Pure: no React, no
// `t()`, no network. It restates no rule of its own: a scheduled workout is done
// on a date when every one of its blocks has a log that date, which is exactly
// `trainingProgress()`'s definition on the API (`api/src/domain/workoutProgress.ts`),
// so the calendar and the summary cards cannot disagree about "completed".

export type DayStatus = 'completed' | 'pending' | 'scheduled' | 'rest';

export interface DayWorkout { scheduled_weekday: number | null; blocks: { id: number }[] | null }
export interface DayBlockLog { workout_block_id: number; logged_date: string }

/** The legend order, and the colour role each status reads in. */
export const DAY_STATUSES: DayStatus[] = ['completed', 'pending', 'scheduled', 'rest'];

/**
 * - no workout scheduled that weekday → rest
 * - every scheduled workout fully logged that date → completed (a partly logged one never is)
 * - a day after today → scheduled
 * - otherwise (today or earlier, not fully done) → pending
 */
export function dayStatus(
  date: string,
  weekday: number,
  today: string,
  workouts: DayWorkout[],
  logs: DayBlockLog[],
): DayStatus {
  const scheduled = workouts.filter((w) => w.scheduled_weekday === weekday);
  if (scheduled.length === 0) return 'rest';
  const done = new Set(logs.filter((l) => String(l.logged_date).slice(0, 10) === date).map((l) => l.workout_block_id));
  const complete = (w: DayWorkout) => (w.blocks ?? []).length > 0 && (w.blocks ?? []).every((b) => done.has(b.id));
  if (scheduled.every(complete)) return 'completed';
  return date > today ? 'scheduled' : 'pending';
}

export function dayStatusKey(status: DayStatus): string {
  return `training.status_${status}`;
}

/** Clamp to the position range of a block's exercise carousel. */
export function clampIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, index));
}
