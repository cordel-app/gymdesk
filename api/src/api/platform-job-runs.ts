/**
 * #1996 stage 2: the Cordel Jobs page's API — superadmin-only, read-only, mounted at
 * `/platform/job-runs`.
 *
 *   GET /   one page of system-job executions, newest first
 *           ?job= &status= &from=YYYY-MM-DD &to=YYYY-MM-DD &limit= &offset=
 *
 * Reads `billing_run_log`, `recurring_booking_run_log` and `job_run_log` as one
 * list (`domain/jobRuns.ts` decides the shape and judges the filters). Nothing is
 * written here and nothing is copied between tables: each invocation has exactly
 * one row, in the table its job already writes. These jobs are system-wide, so no
 * `gym_id` is involved. The two nightly logs hold no HTTP status, which reads `null`.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { requireSuperadmin } from '../infra/tenantContext';
import { db } from '../infra/db';
import {
  JobRunFilter, JobRunRow, normalizeJobRun, parseJobRunFilter,
} from '../domain/jobRuns';

export const platformJobRunsRouter = Router();

/** One SELECT per source, all with the same columns. Literals only — no user input. */
const SOURCES_SQL = `
  SELECT 'billing_run_log' AS source, id AS source_id, 'billing_run' AS job, status,
         started_at, finished_at, NULL AS http_status, NULL AS error_summary,
         JSON_OBJECT('run_date', run_date, 'processed', processed, 'succeeded', succeeded,
                     'failed', failed, 'waived', waived) AS details
    FROM billing_run_log
  UNION ALL
  SELECT 'recurring_booking_run_log', id, 'recurring_bookings', status,
         started_at, finished_at, NULL, NULL,
         JSON_OBJECT('run_date', run_date, 'processed', processed, 'created', created,
                     'skipped', skipped, 'failed', failed, 'notified', notified)
    FROM recurring_booking_run_log
  UNION ALL
  SELECT 'job_run_log', id, job, status, started_at, finished_at, http_status, error_summary, details
    FROM job_run_log
`;

function whereFor(filter: JobRunFilter): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.job) { where.push('r.job = ?'); params.push(filter.job); }
  if (filter.status) { where.push('r.status = ?'); params.push(filter.status); }
  if (filter.from) { where.push('r.started_at >= ?'); params.push(filter.from); }
  if (filter.to) { where.push('r.started_at <= ?'); params.push(filter.to); }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

platformJobRunsRouter.get(
  '/',
  requireSuperadmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = parseJobRunFilter(req.query as Record<string, unknown>);
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });
      const { filter } = parsed;
      const { sql: whereSql, params } = whereFor(filter);

      const { rows: countRows } = await db.query(
        `SELECT COUNT(*) AS total FROM (${SOURCES_SQL}) r ${whereSql}`, params,
      );
      // limit/offset are validated integers (parseJobRunFilter), written into the
      // statement: a bound LIMIT is refused by a prepared statement.
      const { rows } = await db.query(
        `SELECT r.* FROM (${SOURCES_SQL}) r ${whereSql}
          ORDER BY r.started_at DESC, r.source, r.source_id DESC
          LIMIT ${filter.limit} OFFSET ${filter.offset}`,
        params,
      );
      res.json({
        items: (rows as JobRunRow[]).map(normalizeJobRun),
        total: Number(countRows[0].total),
        limit: filter.limit,
        offset: filter.offset,
      });
    } catch (err) { next(err); }
  },
);
