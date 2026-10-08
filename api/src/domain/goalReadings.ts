/**
 * #1037 — what a **goal reading** is, and what the readings of one Assigned
 * Personal Goal add up to.
 *
 * This is the one place the measurement vocabulary and the progress rule live,
 * so the staff router, the member router, the card header and (later) the chart
 * cannot disagree about a percentage — the shape `api/src/domain/goalTarget.ts`
 * already has for the target the readings are measured against, and
 * `api/src/domain/personalGoalAssignment.ts` for the assignment itself.
 *
 * Four of its answers are the rule rather than the implementation.
 *
 * * **Nothing is stored.** `initial_reading`, `latest_reading` and
 *   `progress_percent` are derived from the readings on every read (§11), so
 *   there is no column to keep in step and no path that can forget to.
 * * **The direction is derived, never declared** (the thread's `Q2`: "please do
 *   not introduce a direction column/property"). `target < initial` means lower
 *   is better, `target > initial` means higher is better, and `target ==
 *   initial` is maintenance. One formula covers the first two, because the sign
 *   of the numerator and of the denominator flip together.
 * * **The active initial reading is the latest one, not the first** (§25). A
 *   superseded initial reading stays exactly where it is (§28) and still
 *   delimits its own period in the chart (§23), but progress is computed from
 *   the one in force now.
 * * **Progress is clamped to 0–100 for display** (§27, confirmed on the
 *   thread), and the unclamped value is never reported: a target overshot reads
 *   `100%` and a member who moved the wrong way reads `0%`.
 */

import { effectiveTarget, type Normalized, type TargetType } from './goalTarget';

/** `value` is DECIMAL(10,2) (migration 224), the same shape as a target. */
export const READING_VALUE_MAX = 99999999.99;

/**
 * How far a client's clock may run ahead of the server's before a reading is
 * read as being *in the future*. A browser that is a few seconds fast is not
 * claiming to have measured something that has not happened yet.
 */
export const RECORDED_AT_SKEW_MS = 5 * 60 * 1000;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export interface GoalReading {
  id: number;
  /** The measurement itself, in the assignment's own unit. */
  value: number;
  /** Milliseconds since the epoch — what every rule below orders by. */
  recordedAt: number;
  /** Whether this reading is an initial-reading period boundary (§21). */
  isInitial: boolean;
}

/**
 * A reading's value is **required** — unlike a target, which may legitimately
 * be absent — because a reading with no number is not a measurement. §31's
 * "do not allow arbitrary text as a reading" is this function.
 */
export function normalizeReadingValue(input: unknown): Normalized<number> {
  if (input === undefined || input === null || input === '') {
    return { error: 'value is required' };
  }
  if (typeof input !== 'number' && typeof input !== 'string') {
    return { error: 'value must be a number' };
  }
  const n = typeof input === 'number' ? input : Number(input);
  if (!Number.isFinite(n)) return { error: 'value must be a number' };
  if (n < 0) return { error: 'value must be zero or greater' };
  if (n > READING_VALUE_MAX) return { error: `value must be at most ${READING_VALUE_MAX}` };
  // Rounded to the column's own scale rather than refused, exactly as
  // `normalizeTargetValue()` reasons: `82.456` is a human reading a scale.
  return { value: Math.round(n * 100) / 100 };
}

/**
 * When the measurement was taken, as the `YYYY-MM-DD HH:MM:SS` UTC string the
 * DATETIME column stores.
 *
 * `undefined` means the request did not name a time, which the route reads as
 * *now* (§32's default) — it is not an error, and it is not the same as a bad
 * value. A **date-only** value is accepted at midnight UTC, because the Add
 * reading dialog offers a date (§3) while the column keeps a time; both forms
 * therefore sort together and §33's two readings on one date stay distinct
 * through their times and, failing that, their ids.
 *
 * A time in the **future** is refused. §32 allows historical dates only, and a
 * measurement cannot be taken before it happens — a mistyped year would
 * otherwise become the "latest reading" (§10) for ever, with every later
 * reading hidden behind it.
 */
export function normalizeRecordedAt(
  input: unknown,
  now: Date = new Date(),
): Normalized<string | undefined> {
  if (input === undefined || input === null || input === '') return { value: undefined };
  if (typeof input !== 'string') return { error: 'recorded_at must be a date or date-time string' };
  const text = input.trim();
  if (text.length === 0) return { value: undefined };

  const iso = DATE_ONLY.test(text) ? `${text}T00:00:00Z` : text;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return { error: 'recorded_at must be a date or date-time string' };
  }
  if (DATE_ONLY.test(text) && parsed.toISOString().slice(0, 10) !== text) {
    return { error: 'recorded_at must be a real date (YYYY-MM-DD)' };
  }
  if (parsed.getTime() > now.getTime() + RECORDED_AT_SKEW_MS) {
    return { error: 'recorded_at cannot be in the future' };
  }
  return { value: toMysqlDateTime(parsed) };
}

/** The `YYYY-MM-DD HH:MM:SS` form a DATETIME column takes, in UTC. */
export function toMysqlDateTime(value: Date): string {
  return value.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * §4 — when the initial reading recorded as a goal is **assigned** was taken.
 *
 * "If the existing assignment flow already has an appropriate timestamp, reuse
 * it rather than creating an unnecessary duplicate timestamp": the baseline was
 * measured when the goal started, so the assignment's own `start_date` is that
 * timestamp. An explicit `initial_reading_at` wins over it, and `undefined` —
 * which the insert reads as `UTC_TIMESTAMP()` — is the fallback.
 *
 * A **future** `start_date` is deliberately not used: staff may date an
 * assignment forward, and `normalizeRecordedAt()` refuses a future reading for
 * the reason a mistyped year is refused, so taking it from a field that is
 * allowed to be in the future would be a way around that rule. Such a baseline
 * is recorded now instead.
 */
export function initialReadingTimestamp(input: {
  explicit: string | undefined;
  startDate: string | null;
  now?: Date;
}): string | undefined {
  if (input.explicit) return input.explicit;
  if (!input.startDate) return undefined;
  const now = input.now ?? new Date();
  const started = new Date(`${input.startDate}T00:00:00Z`);
  if (Number.isNaN(started.getTime()) || started.getTime() > now.getTime()) return undefined;
  return `${input.startDate} 00:00:00`;
}

/**
 * A DATETIME reaches the application as a `Date` or as a string depending on
 * the driver's `dateStrings`, so one reader turns a stored row into the shape
 * every rule below works on. An unparsable timestamp answers `null` rather than
 * `NaN`, which would make every comparison silently false.
 */
export function toGoalReading(row: {
  id: unknown; value: unknown; recorded_at: unknown; is_initial: unknown;
}): GoalReading | null {
  const id = Number(row.id);
  const value = Number(row.value);
  const at = row.recorded_at instanceof Date ? row.recorded_at : new Date(String(row.recorded_at).replace(' ', 'T') + 'Z');
  if (!Number.isFinite(id) || !Number.isFinite(value) || Number.isNaN(at.getTime())) return null;
  return {
    id,
    value,
    recordedAt: at.getTime(),
    isInitial: row.is_initial === 1 || row.is_initial === true || row.is_initial === '1',
  };
}

/**
 * Chronological, oldest first, with the id as the tie-breaker — the order the
 * chart draws (§17) and the reverse of the one the history lists (§19). Several
 * readings on one date are ordered by their time and then by the order they
 * were recorded in, never merged (§33).
 */
export function sortReadings(readings: GoalReading[]): GoalReading[] {
  return [...readings].sort((a, b) => a.recordedAt - b.recordedAt || a.id - b.id);
}

/** §10 — the most recent reading, whatever period it falls in. */
export function latestReadingOf(readings: GoalReading[]): GoalReading | null {
  const sorted = sortReadings(readings);
  return sorted.length === 0 ? null : sorted[sorted.length - 1];
}

/**
 * §8/§25 — the **currently active** initial reading: the last period boundary.
 *
 * With no boundary at all it falls back to the earliest reading, because §2
 * says "the first reading represents the starting point" — which is what keeps
 * an assignment whose first reading was recorded without being flagged (a
 * script, a client written before this ticket) from having no baseline and
 * therefore no progress.
 */
export function activeInitialReadingOf(readings: GoalReading[]): GoalReading | null {
  const sorted = sortReadings(readings);
  if (sorted.length === 0) return null;
  const boundaries = sorted.filter((r) => r.isInitial);
  return boundaries.length > 0 ? boundaries[boundaries.length - 1] : sorted[0];
}

/** §22 — the initial-reading history, oldest first. Nothing is ever removed from it. */
export function initialReadingHistoryOf(readings: GoalReading[]): GoalReading[] {
  return sortReadings(readings).filter((r) => r.isInitial);
}

/**
 * §38 — which initial-reading period each reading belongs to, as a 0-based
 * index in chronological order, so the chart can colour one period differently
 * from the next (§23/§24) without deciding the question itself.
 *
 * A reading at or after the *n*th boundary is in period *n*; readings before
 * the first boundary share period 0 with it, which is the un-flagged-first-
 * reading case `activeInitialReadingOf()` reasons about.
 */
export function assignReadingPeriods(readings: GoalReading[]): Map<number, number> {
  const sorted = sortReadings(readings);
  const periods = new Map<number, number>();
  let index = 0;
  let seenBoundary = false;
  for (const reading of sorted) {
    if (reading.isInitial) {
      if (seenBoundary) index += 1;
      seenBoundary = true;
    }
    periods.set(reading.id, index);
  }
  return periods;
}

/**
 * §26/§27 — how far along the member is, as a percentage of the distance from
 * the active initial reading to the target.
 *
 * ```
 * (initial - latest) / (initial - target) x 100
 * ```
 *
 * One formula for both directions: for a weight-loss goal both differences are
 * positive, for a muscle-gain goal both are negative, and the quotient is the
 * same fraction of the same journey. **Maintenance** (`target == initial`) has
 * no distance to divide by, so it answers the thread's own rule instead —
 * `100` while the latest reading is still the target, `0` otherwise — rather
 * than dividing by zero.
 *
 * `null` means "not computable", which is what an assignment with no readings
 * or no target reports: the card shows `—`, never `0%`, because no progress and
 * no measurement are different facts.
 */
export function progressPercent(input: {
  initial: number | null;
  latest: number | null;
  target: number | null;
}): number | null {
  const { initial, latest, target } = input;
  if (initial === null || latest === null || target === null) return null;
  if (!Number.isFinite(initial) || !Number.isFinite(latest) || !Number.isFinite(target)) return null;
  if (initial === target) return latest === target ? 100 : 0;
  const raw = ((initial - latest) / (initial - target)) * 100;
  const clamped = Math.min(100, Math.max(0, raw));
  // One decimal: a percentage of a measurement, not an exact quantity, and the
  // header renders it as a whole number anyway. Rounded here so the staff and
  // member screens cannot report the same progress two ways.
  return Math.round(clamped * 10) / 10;
}

export interface GoalReadingSummary {
  /** The value of the active initial reading (§8), or `null` with no readings. */
  initial_reading: number | null;
  /** When that initial reading was taken, as an ISO 8601 UTC string. */
  initial_reading_at: string | null;
  /** §10 — the most recent reading. */
  latest_reading: number | null;
  latest_reading_at: string | null;
  /** #1229 — what progress is measured against: the absolute target, or baseline + relative change. */
  effective_target: number | null;
  /** §11 — 0..100, or `null` when it cannot be computed. */
  progress_percent: number | null;
  /** How many readings the assignment holds, so a card can say "no readings yet". */
  reading_count: number;
}

export const EMPTY_READING_SUMMARY: GoalReadingSummary = {
  initial_reading: null,
  initial_reading_at: null,
  latest_reading: null,
  latest_reading_at: null,
  effective_target: null,
  progress_percent: null,
  reading_count: 0,
};

/**
 * The five computed fields of §5–§11, from one assignment's readings and its
 * own target. Every surface reports these rather than deriving a percentage of
 * its own (§11's "must update automatically" is this function being called on
 * each read).
 */
export function summarizeReadings(
  readings: GoalReading[],
  configuredTarget: number | null,
  targetType: TargetType = 'absolute',
): GoalReadingSummary {
  const baseline = sortReadings(readings)[0] ?? null;
  const target = effectiveTarget({
    targetType,
    targetValue: configuredTarget,
    baseline: baseline ? baseline.value : null,
  });
  const initial = activeInitialReadingOf(readings);
  const latest = latestReadingOf(readings);
  return {
    initial_reading: initial ? initial.value : null,
    initial_reading_at: initial ? new Date(initial.recordedAt).toISOString() : null,
    latest_reading: latest ? latest.value : null,
    latest_reading_at: latest ? new Date(latest.recordedAt).toISOString() : null,
    effective_target: target,
    progress_percent: progressPercent({
      initial: initial ? initial.value : null,
      latest: latest ? latest.value : null,
      target,
    }),
    reading_count: readings.length,
  };
}
