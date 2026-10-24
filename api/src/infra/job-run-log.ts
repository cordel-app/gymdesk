/**
 * #1996 stage 1: one history row per invocation of the system jobs that have no
 * run log of their own (`billing_run_log` / `recurring_booking_run_log` cover
 * the two nightly runs).
 *
 * `startJobRun()` writes the `in_progress` row before the work, `finishJobRun()`
 * closes it on every exit path. Neither ever throws: a failure to write the log
 * must not change what the job answers nor hide the job's own error.
 * `details` is the job's counters only — never a request body, header or secret.
 */

import { db } from './db';

export const JOB_NAMES = [
  'billing_cleanup',
  'promotion_lifecycle',
  'plan_allowance_renewals',
  'booking_reminders',
] as const;
export type JobName = (typeof JOB_NAMES)[number];

export type JobRunStatus = 'in_progress' | 'completed' | 'failed' | 'skipped';

const ERROR_SUMMARY_MAX = 255;

/** A short message that is safe to store and show: single line, no stack, bounded. */
export function safeErrorSummary(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/\s+/g, ' ').trim().slice(0, ERROR_SUMMARY_MAX);
}

export async function startJobRun(job: JobName): Promise<number | null> {
  try {
    const { insertId } = await db.query(
      `INSERT INTO job_run_log (job, status, started_at) VALUES (?, 'in_progress', UTC_TIMESTAMP())`,
      [job],
    );
    return insertId;
  } catch {
    return null;
  }
}

export async function finishJobRun(
  runId: number | null,
  status: Exclude<JobRunStatus, 'in_progress'>,
  opts: { httpStatus?: number; details?: Record<string, unknown> | null; error?: unknown } = {},
): Promise<void> {
  if (runId == null) return;
  try {
    await db.query(
      `UPDATE job_run_log
          SET status = ?, finished_at = UTC_TIMESTAMP(), http_status = ?, details = ?, error_summary = ?
        WHERE id = ?`,
      [
        status,
        opts.httpStatus ?? null,
        opts.details ? JSON.stringify(opts.details) : null,
        opts.error === undefined ? null : safeErrorSummary(opts.error),
        runId,
      ],
    );
  } catch {
    // The job's own outcome wins over a log write that failed.
  }
}
