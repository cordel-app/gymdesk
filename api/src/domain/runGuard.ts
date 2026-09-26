/**
 * #780: the guard that decides whether a system-wide nightly run may start.
 *
 * Both `POST /billing/run` and `POST /recurring-bookings/run` used to refuse
 * when their singleton's `last_run_at` was less than 23 hours old, stamped at
 * the *start* of the run. That shape had two defects the ticket names:
 *
 * 1. **A delayed cron skipped a day.** GitHub Actions documents that
 *    `schedule` triggers may run late under load. Monday at 07:30 UTC followed
 *    by Tuesday at 06:00 is 22.5 h — inside the window — so Tuesday was
 *    refused and nobody was charged that day.
 * 2. **A crashed run locked the day.** The stamp was written before the first
 *    membership was touched, so a run that threw half way left it behind and
 *    every re-run for the next 23 hours was refused. Recovery was a manual
 *    `UPDATE`.
 *
 * The rule is now a calendar one: **at most one *completed* run per UTC date**.
 * A run that started today and did not finish does not block a re-run, while
 * concurrency is still prevented — a run that started less than
 * `STALE_RUN_MINUTES` ago and has not finished is `in_progress` and refuses a
 * second start. Past that, the earlier run is presumed dead (container
 * restart, deploy mid-run) and a fresh one may take over.
 *
 * Idempotency of the work itself is unchanged and is what makes the takeover
 * safe: a membership the dead run already advanced has `next_billing_date` in
 * the future and is not selected again.
 *
 * Pure on purpose — the two routers must not each re-derive this, and the
 * interesting cases (a late run, a crashed run, a stale lock) are all clock
 * arithmetic that would otherwise need a database to test. The rows come from
 * `infra/run-log.ts`, which is what talks to MySQL. Unit-tested in
 * `api/src/test/run-guard.unit.test.ts`.
 */

/** `billing_run_log.status` / `recurring_booking_run_log.status` (migration 193). */
export type RunLogStatus = 'in_progress' | 'completed' | 'failed';

export const RUN_LOG_STATUSES: readonly RunLogStatus[] = ['in_progress', 'completed', 'failed'];

/**
 * How long a run may stay `in_progress` before a new one may take over.
 *
 * The ticket's guidance: "pick N from the run's realistic duration; 30 minutes
 * is plenty for today's volumes". The billing run's own HTTP client gives up
 * after 120 s (`.github/workflows/billing-run.yml`) and the recurring booking
 * run after 600 s, so 30 minutes is well clear of both while still letting a
 * crashed run be retried within the same night.
 */
export const STALE_RUN_MINUTES = 30;

/** The columns of a run row the guard reads. */
export interface RunGuardRow {
  run_date: string | Date;
  status: string;
  started_at: string | Date | null;
}

export type RunGuardDecision =
  | { allow: true }
  | { allow: false; reason: 'already_completed_today'; runDate: string }
  | { allow: false; reason: 'in_progress'; startedAt: string | null };

/** The UTC calendar date a moment falls on, as `YYYY-MM-DD`. */
export function utcDateString(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * mysql2 hands a DATE back as a string or a `Date` depending on the
 * connection's timezone config (same note as `billing.ts`'s own `toDateOnly`),
 * and the guard compares dates as strings.
 */
export function toDateOnly(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

/** A DATETIME as an ISO string, or null when the column was NULL. */
function toIsoOrNull(value: string | Date | null): string | null {
  if (value == null) return null;
  const at = value instanceof Date ? value : new Date(`${String(value).replace(' ', 'T')}Z`);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/**
 * Has this `in_progress` row been running long enough to be presumed dead?
 *
 * A row with no `started_at` cannot be aged, so it is treated as stale rather
 * than as an eternal lock — the column is NOT NULL in migration 193, so this
 * only covers a row written by something other than `claimRun`.
 */
export function isStaleRun(startedAt: string | Date | null, now: Date): boolean {
  const iso = toIsoOrNull(startedAt);
  if (iso === null) return true;
  const ageMinutes = (now.getTime() - new Date(iso).getTime()) / 60_000;
  return ageMinutes >= STALE_RUN_MINUTES;
}

/**
 * The guard itself. `rows` are the recent run rows of one log table (the
 * caller's `FOR UPDATE` read); only today's completed runs and any
 * `in_progress` row matter, so it is cheap to pass a couple of days of them.
 *
 * "Already completed today" is checked first: if a run somehow both completed
 * and is in progress on the same date, the completed one is the honest answer
 * to give the caller — the work is done, and a second attempt is a no-op
 * rather than something to retry later.
 */
export function evaluateRunGuard(rows: RunGuardRow[], now: Date): RunGuardDecision {
  const today = utcDateString(now);

  const completedToday = rows.find(
    (r) => r.status === 'completed' && toDateOnly(r.run_date) === today,
  );
  if (completedToday) {
    return { allow: false, reason: 'already_completed_today', runDate: today };
  }

  const running = rows.find((r) => r.status === 'in_progress' && !isStaleRun(r.started_at, now));
  if (running) {
    return { allow: false, reason: 'in_progress', startedAt: toIsoOrNull(running.started_at) };
  }

  return { allow: true };
}
