/**
 * #782: is a nightly run overdue?
 *
 * `POST /billing/run` and `POST /recurring-bookings/run` are fired by GitHub
 * Actions crons. When GitHub skips or delays a scheduled workflow (it does,
 * under load), nothing inside Gymdesk notices: no run means no log line, no
 * error and no alert. `GET /health/runs` turns the absence into something a
 * prober outside GitHub (a Grafana Cloud synthetic check) can see, by
 * reporting, per run log, when a run last reached `completed` and whether that
 * is longer ago than the threshold.
 *
 * Only a `completed` row counts (migration 193): a `failed` row is a run that
 * threw, an `in_progress` one has not finished, and the second daily attempt's
 * `already_completed_today` answer writes no row at all — correctly, since the
 * earlier run is the one that completed.
 *
 * This module is the pure decision; `api/health.ts` does the SQL.
 */

/** What `RUN_FRESHNESS_THRESHOLD_HOURS` defaults to when nothing is set. */
export const RUN_FRESHNESS_DEFAULT_HOURS = 26;

/**
 * Floor on the configured threshold. The runs are daily, so anything below a
 * few hours would page every afternoon; an hour is simply the smallest value
 * that is not obviously a typo (`0`, a negative, an empty string).
 */
export const RUN_FRESHNESS_MIN_HOURS = 1;

/**
 * The staleness threshold in hours, read per call so a test — and a change
 * without a restart — sees the current value. Non-numeric or below the floor
 * falls back to the default; a fraction is floored to whole hours.
 */
export function runFreshnessThresholdHours(): number {
  const raw = Number(process.env.RUN_FRESHNESS_THRESHOLD_HOURS);
  if (!Number.isFinite(raw) || raw < RUN_FRESHNESS_MIN_HOURS) {
    return RUN_FRESHNESS_DEFAULT_HOURS;
  }
  return Math.floor(raw);
}

export interface RunFreshness {
  /** ISO-8601 UTC `finished_at` of the latest `completed` run, or null if none ever completed. */
  last_completed_at: string | null;
  /** Hours since that run finished, two decimals; null when there is none. */
  age_hours: number | null;
  /** True when no run ever completed or the latest one is older than the threshold. */
  stale: boolean;
}

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * Decide freshness for one run log.
 *
 * A log that has never completed a run is **stale**, not fresh: a deployment
 * whose cron never fired is exactly what the alert exists to catch. A
 * `finished_at` in the future (clock skew between the DB and the API) reads as
 * age 0 rather than a negative number. The comparison is strict — exactly the
 * threshold is still fresh.
 */
export function evaluateRunFreshness(
  lastCompletedAt: Date | null,
  now: Date,
  thresholdHours: number,
): RunFreshness {
  if (!lastCompletedAt || Number.isNaN(lastCompletedAt.getTime())) {
    return { last_completed_at: null, age_hours: null, stale: true };
  }
  const ageMs = Math.max(0, now.getTime() - lastCompletedAt.getTime());
  const ageHours = ageMs / MS_PER_HOUR;
  return {
    last_completed_at: lastCompletedAt.toISOString(),
    age_hours: Math.round(ageHours * 100) / 100,
    stale: ageHours > thresholdHours,
  };
}
