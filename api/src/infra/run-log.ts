/**
 * #780: claiming and finishing a system-wide nightly run.
 *
 * `billing_run_log` (migration 111) and `recurring_booking_run_log`
 * (migration 170) were single-row tables holding one `last_run_at` stamp.
 * Migration 193 turns both into **histories** — one row per run, carrying
 * `started_at`, `finished_at`, `status`, the UTC `run_date` and the run's own
 * counters — because that is what the guard needs to tell a late run from a
 * second one, and what the freshness alert (#782) and the dashboard read.
 *
 * Both tables keep migration 111's deliberate exception to the
 * `gym_id`-on-every-table rule: a nightly run is a system-wide job, not tenant
 * data.
 *
 * The lifecycle is two calls:
 *
 *   const claim = await claimRun('billing_run_log');
 *   if (!claim.claimed) …answer per the reason…
 *   try   { …the run… ; await finishRun('billing_run_log', claim.runId, 'completed', counters) }
 *   catch { await finishRun('billing_run_log', claim.runId, 'failed', counters); throw }
 *
 * `finishRun` in the failure path is what stops a crash from locking the day:
 * the row stops being `in_progress`, and because it never reached `completed`
 * the calendar-date guard lets the next attempt run. Even if the process dies
 * hard and never reaches it, `STALE_RUN_MINUTES` retires the row.
 *
 * The guard's decision lives in `domain/runGuard.ts` (pure, unit-tested); this
 * module is only the SQL around it.
 */

import { db } from './db';
import {
  RunGuardRow,
  RunLogStatus,
  evaluateRunGuard,
  utcDateString,
} from '../domain/runGuard';

/** The two run-log tables. Not user input — a closed set, checked below. */
export type RunLogTable = 'billing_run_log' | 'recurring_booking_run_log';

export const RUN_LOG_TABLES: readonly RunLogTable[] = [
  'billing_run_log',
  'recurring_booking_run_log',
];

/**
 * The counter columns each log carries (migration 193). A run reports the
 * counters of its own job — the billing run charges, the recurring booking run
 * books — so the two lists differ, and `finishRun` writes only the columns
 * named here. Both the table name and every counter name reaching the SQL
 * below come from these literals, never from a request.
 */
export const RUN_LOG_COUNTERS: Record<RunLogTable, readonly string[]> = {
  billing_run_log: ['processed', 'succeeded', 'failed', 'waived'],
  recurring_booking_run_log: ['processed', 'created', 'skipped', 'failed', 'notified'],
};

export type ClaimResult =
  | { claimed: true; runId: number; runDate: string }
  | { claimed: false; reason: 'already_completed_today'; runDate: string }
  | { claimed: false; reason: 'in_progress'; startedAt: string | null };

function assertKnownTable(table: RunLogTable): void {
  if (!RUN_LOG_TABLES.includes(table)) {
    throw new Error(`Unknown run log table: ${String(table)}`);
  }
}

/**
 * Take today's run, or say why not.
 *
 * The read and the insert share one transaction and the read is `FOR UPDATE`,
 * so two calls arriving together cannot both decide the table is free: the
 * second blocks until the first has inserted its `in_progress` row, then sees
 * it. The transaction is deliberately short — it covers the claim only, never
 * the run itself, which takes minutes and must not hold a row lock (or one of
 * the pool's ten connections) while it charges cards.
 *
 * The `WHERE` narrows to the only rows that can affect the decision — anything
 * still `in_progress`, plus the last two calendar days — so the guard reads a
 * couple of rows however long the history is. The `OR` means MySQL scans the
 * table to find them and `FOR UPDATE` therefore locks all of it, which is the
 * point: the claim is the one place two runs must not overlap, and it holds
 * that lock for the milliseconds the insert takes, once a night, on a table
 * that grows by one row a day.
 */
export async function claimRun(table: RunLogTable, now: Date = new Date()): Promise<ClaimResult> {
  assertKnownTable(table);
  const today = utcDateString(now);

  return db.transaction(async (tx) => {
    const { rows } = await tx.query<RunGuardRow & { id: number }>(
      `SELECT id, run_date, status, started_at
         FROM ${table}
        WHERE status = 'in_progress'
           OR run_date >= DATE_SUB(?, INTERVAL 1 DAY)
        FOR UPDATE`,
      [today],
    );

    const decision = evaluateRunGuard(rows, now);
    if (!decision.allow) {
      return decision.reason === 'already_completed_today'
        ? { claimed: false, reason: 'already_completed_today', runDate: decision.runDate }
        : { claimed: false, reason: 'in_progress', startedAt: decision.startedAt };
    }

    // Any `in_progress` row that survived to here is older than
    // STALE_RUN_MINUTES, i.e. a run whose process died without reaching
    // `finishRun`. Record that rather than leaving a row that claims to be
    // running for ever — the freshness alert and the dashboard read these.
    const stale = rows.filter((r) => r.status === 'in_progress').map((r) => r.id);
    if (stale.length > 0) {
      await tx.query(
        `UPDATE ${table}
            SET status = 'failed', finished_at = UTC_TIMESTAMP()
          WHERE id IN (${stale.map(() => '?').join(',')})`,
        stale,
      );
    }

    const { insertId } = await tx.query(
      `INSERT INTO ${table} (run_date, status, started_at) VALUES (?, 'in_progress', UTC_TIMESTAMP())`,
      [today],
    );

    return { claimed: true, runId: insertId, runDate: today };
  });
}

/**
 * Close a claimed run. `counters` is written for the columns this log declares
 * and nothing else, so a caller that passes an unknown key gets it ignored
 * rather than injected into the statement.
 *
 * Called from the run's `catch` as well as its success path — a `failed` row
 * is what keeps the calendar guard from treating a crash as today's run.
 */
export async function finishRun(
  table: RunLogTable,
  runId: number,
  status: Extract<RunLogStatus, 'completed' | 'failed'>,
  counters: Record<string, number> = {},
): Promise<void> {
  assertKnownTable(table);

  const columns = RUN_LOG_COUNTERS[table].filter((c) => typeof counters[c] === 'number');
  const assignments = ['status = ?', 'finished_at = UTC_TIMESTAMP()', ...columns.map((c) => `${c} = ?`)];
  const params: Array<string | number> = [status, ...columns.map((c) => counters[c]), runId];

  await db.query(`UPDATE ${table} SET ${assignments.join(', ')} WHERE id = ?`, params);
}

/**
 * The last run of this log that reached `completed`, for the freshness read
 * (#782) and for tests. `null` when the log has never completed a run.
 */
export async function lastCompletedRun(
  table: RunLogTable,
): Promise<{ run_date: string; finished_at: Date | string | null } | null> {
  assertKnownTable(table);
  const { rows } = await db.query<{ run_date: string; finished_at: Date | string | null }>(
    `SELECT run_date, finished_at
       FROM ${table}
      WHERE status = 'completed'
      ORDER BY finished_at DESC, id DESC
      LIMIT 1`,
  );
  return rows[0] ?? null;
}
