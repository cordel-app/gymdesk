/**
 * #1224 — **My Progress**: what a member's exercise history adds up to.
 *
 * Nothing here is stored. `exercise_logs` is the member's history for ever
 * (it is keyed to the exercise, never to a plan, so an expired or deleted plan's
 * logs still count) and every figure is derived on read from it, with
 * `exercise_log_sets` read-only for weight and reps — the only place the Members
 * App writes them. This module is the one place that decides what a day, a
 * best result and the default result type are; `api/src/api/me-progress.ts` is
 * the SQL half.
 *
 * Three of its answers are the rule rather than the implementation.
 *
 * * **A skipped log is not a day exercised.** It is the member saying they did
 *   not do it.
 * * **Result types are never combined.** The best result is read in exactly one
 *   result type; a type the logs hold no data for (distance, pace, speed,
 *   calories, rpe, rest time) is `null` and reads `—`, never 0.
 * * **The default result type is deterministic**: the exercise's only allowed
 *   type, else the first by id. A random pick would make the figure change
 *   between visits.
 */

export interface ProgressSet { set_number: number; weight: number | null; reps: number | null }

export interface ProgressLog {
  logged_date: string;
  duration_seconds: number | null;
  skipped: boolean;
  sets: ProgressSet[];
}

export interface AllowedResultType { id: number; slug: string }

export type MeasuredSlug = 'weight' | 'repetitions' | 'duration';

export interface BestResult { slug: MeasuredSlug; value: number }

export interface ExerciseProgressDay {
  logged_date: string;
  max_weight: number | null;
  /** The day's value in the exercise's result type; what the chart plots. */
  value: number | null;
  duration_seconds: number | null;
  sets: ProgressSet[];
}

const MEASURED: readonly string[] = ['weight', 'repetitions', 'duration'];

export function isMeasuredSlug(slug: string | null | undefined): slug is MeasuredSlug {
  return !!slug && MEASURED.includes(slug);
}

/** The result type "Best result" is read in; `null` when the exercise allows none. */
export function defaultResultType(allowed: AllowedResultType[]): AllowedResultType | null {
  if (allowed.length === 0) return null;
  return [...allowed].sort((a, b) => a.id - b.id)[0];
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const maxOf = (values: Array<number | null>): number | null => {
  const present = values.filter((v): v is number => v !== null);
  return present.length ? Math.max(...present) : null;
};

/** The performed logs: a skipped one is excluded everywhere. */
export function performedLogs(logs: ProgressLog[]): ProgressLog[] {
  return logs.filter((l) => !l.skipped);
}

export function daysExercised(logs: ProgressLog[]): number {
  return new Set(performedLogs(logs).map((l) => l.logged_date)).size;
}

export function maxWeight(logs: ProgressLog[]): number | null {
  return maxOf(performedLogs(logs).flatMap((l) => l.sets.map((s) => num(s.weight))));
}

/** One log's value in a result type, `null` when it holds none. */
function logValue(log: ProgressLog, slug: string | null): number | null {
  if (slug === 'weight') return maxOf(log.sets.map((s) => num(s.weight)));
  if (slug === 'repetitions') return maxOf(log.sets.map((s) => num(s.reps)));
  if (slug === 'duration') return num(log.duration_seconds);
  return null;
}

/** The best (highest) value in the given result type, or `null` — `—` on screen. */
export function bestResult(logs: ProgressLog[], resultType: AllowedResultType | null): BestResult | null {
  if (!resultType || !isMeasuredSlug(resultType.slug)) return null;
  const value = maxOf(performedLogs(logs).map((l) => logValue(l, resultType.slug)));
  return value === null ? null : { slug: resultType.slug, value };
}

/** One entry per performed date, oldest first. */
export function progressDays(logs: ProgressLog[], resultType: AllowedResultType | null): ExerciseProgressDay[] {
  const byDate = new Map<string, ProgressLog[]>();
  for (const l of performedLogs(logs)) {
    const list = byDate.get(l.logged_date) ?? [];
    list.push(l);
    byDate.set(l.logged_date, list);
  }
  return [...byDate.keys()].sort().map((date) => {
    const dayLogs = byDate.get(date)!;
    // A registration is its own log, so every one was stored as Set 1: the
    // number is the set's position among that exercise's sets of the day.
    const sets = dayLogs.flatMap((l) => l.sets).map((s, i) => ({
      set_number: i + 1, weight: num(s.weight), reps: num(s.reps),
    }));
    return {
      logged_date: date,
      max_weight: maxOf(sets.map((s) => s.weight)),
      value: maxOf(dayLogs.map((l) => logValue(l, resultType?.slug ?? null))),
      duration_seconds: maxOf(dayLogs.map((l) => num(l.duration_seconds))),
      sets,
    };
  });
}

export interface ExerciseProgressSummary {
  days_exercised: number;
  max_weight: number | null;
  result_kind: AllowedResultType | null;
  best_result: BestResult | null;
}

export function summarizeExercise(logs: ProgressLog[], allowed: AllowedResultType[]): ExerciseProgressSummary {
  const resultType = defaultResultType(allowed);
  return {
    days_exercised: daysExercised(logs),
    max_weight: maxWeight(logs),
    result_kind: resultType,
    best_result: bestResult(logs, resultType),
  };
}
