/**
 * #1996 stage 2: the normalized shape of one system-job execution, and the
 * judgement of the read API's filters.
 *
 * Three stores hold a job's history: `billing_run_log` (`/billing/run`),
 * `recurring_booking_run_log` (`/recurring-bookings/run`) and `job_run_log`
 * (the four jobs of stage 1). `GET /platform/job-runs` reads all three and
 * answers one shape, so this module is the one place that says which jobs
 * exist, which statuses a run can have and how a filter value is judged.
 *
 * `details` is each source's own counters, unchanged. `http_status` is the
 * status the endpoint answered with and is never an exit code; only
 * `job_run_log` stores one, the two nightly logs report `null`.
 */

export const JOB_RUN_JOBS = [
  'billing_run',
  'recurring_bookings',
  'billing_cleanup',
  'promotion_lifecycle',
  'plan_allowance_renewals',
  'booking_reminders',
] as const;
export type JobRunJob = (typeof JOB_RUN_JOBS)[number];

export const JOB_RUN_STATUSES = ['in_progress', 'completed', 'failed', 'skipped'] as const;
export type JobRunStatusValue = (typeof JOB_RUN_STATUSES)[number];

/** Which table a job's history lives in. */
export const JOB_RUN_SOURCES = {
  billing_run: 'billing_run_log',
  recurring_bookings: 'recurring_booking_run_log',
  billing_cleanup: 'job_run_log',
  promotion_lifecycle: 'job_run_log',
  plan_allowance_renewals: 'job_run_log',
  booking_reminders: 'job_run_log',
} as const satisfies Record<JobRunJob, string>;

export interface JobRun {
  /** Unique across sources: `<source table>:<row id>`. */
  id: string;
  job: JobRunJob;
  status: JobRunStatusValue;
  /** UTC, ISO 8601. */
  started_at: string;
  /** UTC, ISO 8601; `null` while the run is in progress. */
  finished_at: string | null;
  /** Derived from the two timestamps; `null` while in progress. */
  duration_seconds: number | null;
  /** The status the endpoint answered with. Not an exit code. */
  http_status: number | null;
  /** A short, safe message for a failed run. */
  error_summary: string | null;
  /** The source's own counters, as stored. */
  details: Record<string, unknown>;
}

export const DEFAULT_JOB_RUN_LIMIT = 25;
export const MAX_JOB_RUN_LIMIT = 100;

export interface JobRunFilter {
  job: JobRunJob | null;
  status: JobRunStatusValue | null;
  /** `YYYY-MM-DD 00:00:00`, UTC, inclusive. */
  from: string | null;
  /** `YYYY-MM-DD 23:59:59`, UTC, inclusive. */
  to: string | null;
  limit: number;
  offset: number;
}

export type JobRunFilterResult =
  | { ok: true; filter: JobRunFilter }
  | { ok: false; error: string };

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(value: string): boolean {
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function one(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  return typeof value === 'string' ? value : String(value);
}

function intParam(value: unknown, name: string, min: number, max: number, fallback: number):
  { ok: true; value: number } | { ok: false; error: string } {
  const raw = one(value);
  if (raw === null) return { ok: true, value: fallback };
  if (!/^\d+$/.test(raw)) return { ok: false, error: `${name} must be an integer` };
  const n = Number(raw);
  if (n < min || n > max) return { ok: false, error: `${name} must be between ${min} and ${max}` };
  return { ok: true, value: n };
}

/** An unknown value is a 400, never ignored: a mistyped filter must not widen the list. */
export function parseJobRunFilter(query: Record<string, unknown>): JobRunFilterResult {
  const job = one(query.job);
  if (job !== null && !(JOB_RUN_JOBS as readonly string[]).includes(job)) {
    return { ok: false, error: `job must be one of: ${JOB_RUN_JOBS.join(', ')}` };
  }
  const status = one(query.status);
  if (status !== null && !(JOB_RUN_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, error: `status must be one of: ${JOB_RUN_STATUSES.join(', ')}` };
  }
  const from = one(query.from);
  if (from !== null && !(DATE_ONLY.test(from) && isRealDate(from))) {
    return { ok: false, error: 'from must be a date (YYYY-MM-DD)' };
  }
  const to = one(query.to);
  if (to !== null && !(DATE_ONLY.test(to) && isRealDate(to))) {
    return { ok: false, error: 'to must be a date (YYYY-MM-DD)' };
  }
  if (from !== null && to !== null && from > to) {
    return { ok: false, error: 'from must not be after to' };
  }
  const limit = intParam(query.limit, 'limit', 1, MAX_JOB_RUN_LIMIT, DEFAULT_JOB_RUN_LIMIT);
  if (!limit.ok) return limit;
  const offset = intParam(query.offset, 'offset', 0, 1_000_000, 0);
  if (!offset.ok) return offset;
  return {
    ok: true,
    filter: {
      job: job as JobRunJob | null,
      status: status as JobRunStatusValue | null,
      from: from === null ? null : `${from} 00:00:00`,
      to: to === null ? null : `${to} 23:59:59`,
      limit: limit.value,
      offset: offset.value,
    },
  };
}

/** A DATETIME stored in UTC, as the driver returns it, to ISO 8601. */
export function utcIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const s = String(value);
  const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function parseDetails(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export interface JobRunRow {
  source: string;
  source_id: number | string;
  job: string;
  status: string;
  started_at: unknown;
  finished_at: unknown;
  http_status: number | null;
  error_summary: string | null;
  details: unknown;
}

/** One source row to the normalized run. Pure. */
export function normalizeJobRun(row: JobRunRow): JobRun {
  const started = utcIso(row.started_at) ?? '';
  const finished = utcIso(row.finished_at);
  const duration = started && finished
    ? Math.max(0, Math.round((Date.parse(finished) - Date.parse(started)) / 1000))
    : null;
  return {
    id: `${row.source}:${row.source_id}`,
    job: row.job as JobRunJob,
    status: row.status as JobRunStatusValue,
    started_at: started,
    finished_at: finished,
    duration_seconds: duration,
    http_status: row.http_status === null || row.http_status === undefined ? null : Number(row.http_status),
    error_summary: row.error_summary ?? null,
    details: parseDetails(row.details),
  };
}
