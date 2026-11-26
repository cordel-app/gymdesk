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
  JobRun, JobRunFilter, JobRunRow, normalizeJobRun, parseJobRunFilter,
} from '../domain/jobRuns';
import { SYSTEM_JOBS, manualRunRefusal, systemJobOf } from '../domain/systemJobs';
import { callJobRoute, isManualRunInFlight } from './system-job-trigger';

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

/**
 * #3471: the latest run of each job, across all three stores, by start time — the
 * same rows the list above reads, so a scheduled run and a manual one are one history.
 */
async function latestRuns(job?: string): Promise<Map<string, JobRun>> {
  const { rows } = await db.query(
    `SELECT r.* FROM (
       SELECT s.*, ROW_NUMBER() OVER (
                PARTITION BY s.job ORDER BY s.started_at DESC, s.source, s.source_id DESC) AS rn
         FROM (${SOURCES_SQL}) s ${job ? 'WHERE s.job = ?' : ''}
     ) r WHERE r.rn = 1`,
    job ? [job] : [],
  );
  const out = new Map<string, JobRun>();
  for (const row of rows as JobRunRow[]) {
    const run = normalizeJobRun(row);
    out.set(run.job, run);
  }
  return out;
}

/**
 * GET /platform/job-runs/jobs — #3471: every registered job, never-run ones included,
 * with whether the application may start it and its latest run (`null` if none).
 */
platformJobRunsRouter.get(
  '/jobs',
  requireSuperadmin,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const latest = await latestRuns();
      res.json({
        items: SYSTEM_JOBS.map((j) => ({
          job: j.job,
          manual: j.manual && !!process.env[j.secretEnv],
          running: isManualRunInFlight(j.job),
          latest_run: latest.get(j.job) ?? null,
        })),
      });
    } catch (err) { next(err); }
  },
);

/**
 * POST /platform/job-runs/jobs/:job/run — #3471: starts one job now, through its own
 * internal route (`system-job-trigger.ts`), and answers with the job's latest run.
 *
 *   200 { job, http_status, latest_run }        the job's route answered 2xx
 *   409 { error: 'job_already_running' }        a manual start is still waiting, or the
 *                                               route answered 429 (a run in progress)
 *   409 { error: 'manual_run_not_supported' }   the job is the scheduler's alone
 *   503 { error: 'not_configured' }             the job's secret is not set here
 *   502 { error: 'job_failed', http_status, latest_run }  the route answered an error
 */
platformJobRunsRouter.post(
  '/jobs/:job/run',
  requireSuperadmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const jobName = String(req.params.job);
      const entry = systemJobOf(jobName);
      const secret = entry ? process.env[entry.secretEnv] : undefined;
      const refusal = manualRunRefusal(jobName, !!secret);
      if (refusal === 'unknown_job') return res.status(404).json({ error: refusal });
      if (refusal === 'manual_run_not_supported') return res.status(409).json({ error: refusal });
      if (refusal === 'not_configured') return res.status(503).json({ error: refusal });
      if (isManualRunInFlight(entry!.job)) return res.status(409).json({ error: 'job_already_running' });

      const answer = await callJobRoute(req.app, entry!, secret!);
      const latest = (await latestRuns(entry!.job)).get(entry!.job) ?? null;
      if (answer.status === 429) {
        return res.status(409).json({ error: 'job_already_running', http_status: 429, latest_run: latest });
      }
      if (answer.status < 200 || answer.status >= 300) {
        return res.status(502).json({ error: 'job_failed', http_status: answer.status, latest_run: latest });
      }
      res.json({ job: entry!.job, http_status: answer.status, latest_run: latest });
    } catch (err) { next(err); }
  },
);
