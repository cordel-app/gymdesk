// #1527 — the status of each day in My Training's week card. Pure: no React, no
// `t()`, no network. It restates no rule of its own: a scheduled workout is done
// on a date when every one of its blocks has a log that date, which is exactly
// `trainingProgress()`'s definition on the API (`api/src/domain/workoutProgress.ts`),
// so the calendar and the summary cards cannot disagree about "completed".

export type DayStatus = 'completed' | 'pending' | 'scheduled' | 'rest';
/** #1603: My Nutrition also has a closed day scored above 50 % but short of 100 % (half red, half green). */
export type NutritionDayStatus = DayStatus | 'partial';

export interface DayWorkout { scheduled_weekday: number | null; blocks: { id: number }[] | null }
export interface DayBlockLog { workout_block_id: number; logged_date: string; level?: string | null }

/**
 * #3494 — a block log's level and its credit: Fully Done (`done`, the old Mark
 * done) 1, Partially Done (`partial`) exactly half. The API's rule
 * (`BLOCK_LEVEL_CREDIT` in `api/src/domain/workoutProgress.ts`), restated
 * because the two apps share no module; a missing level is a full completion.
 */
export type BlockLevel = 'partial' | 'done';
export function blockCredit(level: string | null | undefined): number {
  return level === 'partial' ? 0.5 : 1;
}

/** Each block's credit on a date: the highest level logged for it, so a log repeated never adds up. */
export function blockCredits(logs: DayBlockLog[], date: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const l of logs) {
    if (String(l.logged_date).slice(0, 10) !== date) continue;
    out.set(l.workout_block_id, Math.max(out.get(l.workout_block_id) ?? 0, blockCredit(l.level)));
  }
  return out;
}

/** A block's level on a date for the page's chip and buttons; `null` when it is not logged. */
export function blockLevelOn(credits: ReadonlyMap<number, number>, blockId: number): BlockLevel | null {
  const c = credits.get(blockId);
  if (c === undefined) return null;
  return c >= 1 ? 'done' : 'partial';
}

/** The logs after marking a block at a level: every log of it that date takes the level, or one is added. */
export function withBlockLevel(logs: DayBlockLog[], blockId: number, date: string, level: BlockLevel): DayBlockLog[] {
  const same = (l: DayBlockLog) => l.workout_block_id === blockId && String(l.logged_date).slice(0, 10) === date;
  return logs.some(same)
    ? logs.map((l) => (same(l) ? { ...l, level } : l))
    : [...logs, { workout_block_id: blockId, logged_date: date, level }];
}

/**
 * #3494 — the day's completion, 0..100, from the same rule as the API's
 * `trainingProgress()`: each workout listed that day counts 1 and contributes
 * the mean of its blocks' credit. `null` for a day with no workout listed.
 */
export function dayCompletion(date: string, weekday: number, workouts: DayWorkout[], logs: DayBlockLog[]): number | null {
  const listed = workouts.filter((w) => w.scheduled_weekday === weekday || w.scheduled_weekday === null);
  if (listed.length === 0) return null;
  const credits = blockCredits(logs, date);
  const sum = listed.reduce((s, w) => {
    const blocks = w.blocks ?? [];
    return s + (blocks.length === 0 ? 0 : blocks.reduce((b, x) => b + (credits.get(x.id) ?? 0), 0) / blocks.length);
  }, 0);
  return Math.round((sum / listed.length) * 100);
}

/** The legend order, and the colour role each status reads in. */
export const DAY_STATUSES: DayStatus[] = ['completed', 'pending', 'scheduled', 'rest'];
export const NUTRITION_DAY_STATUSES: NutritionDayStatus[] = ['completed', 'partial', 'pending', 'scheduled', 'rest'];

/**
 * - no workout listed that day (scheduled for that weekday, or with no weekday) → rest
 * - every workout listed that day (scheduled for it, or with no weekday) fully logged that date → completed (a partly logged one never is)
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
  // The day card lists every workout with no weekday beside the scheduled ones
  // (each with its own "mark done"), so the indicator is derived from that same
  // list (#1709): a day showing a workout is never a rest day, and it is green
  // only when all of them are done.
  const scheduled = workouts.filter((w) => w.scheduled_weekday === weekday || w.scheduled_weekday === null);
  if (scheduled.length === 0) return 'rest';
  // #3494: a Partially Done block is not done, so a day with one is never green.
  const credits = blockCredits(logs, date);
  const complete = (w: DayWorkout) => (w.blocks ?? []).length > 0 && (w.blocks ?? []).every((b) => (credits.get(b.id) ?? 0) >= 1);
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
