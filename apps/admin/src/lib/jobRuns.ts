/**
 * #1996 stage 3 — the Cordel → Jobs page's decisions, kept out of the JSX so they are
 * assertable without a browser (`src/test/job-runs.test.ts`).
 *
 * What a run *is* — the jobs, the statuses, the filters — is the API's
 * (`api/src/domain/jobRuns.ts`, served by `GET /platform/job-runs`); this mirrors only
 * the shape the page reads and decides how it is *worded*. Every label is a locale key
 * the page resolves, and the dates a run is filtered by are UTC days like the API's.
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
export type JobRunStatus = (typeof JOB_RUN_STATUSES)[number];

export const JOB_RUN_RESULTS = ['success', 'warning', 'error'] as const;
export type JobRunResult = (typeof JOB_RUN_RESULTS)[number];
export type JobRunIssue = 'failed_records' | 'partial_failures' | 'capped';

export interface JobRun {
  id: string;
  job: JobRunJob;
  status: JobRunStatus;
  started_at: string;
  finished_at: string | null;
  duration_seconds: number | null;
  http_status: number | null;
  error_summary: string | null;
  details: Record<string, unknown>;
  /** The API's derived outcome; `null` when it cannot be told (never invented here). */
  result?: JobRunResult | null;
  issues?: JobRunIssue[];
}

export interface JobRunsResponse {
  items: JobRun[];
  total: number;
  limit: number;
  offset: number;
}

export interface JobRunFilters {
  job: JobRunJob | '';
  status: JobRunStatus | '';
  from: string;
  to: string;
}

export const JOB_RUNS_PAGE_SIZE = 25;
/** The default range is the last 7 UTC days, today included. */
export const DEFAULT_RANGE_DAYS = 7;

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function defaultJobRunFilters(now: Date = new Date()): JobRunFilters {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (DEFAULT_RANGE_DAYS - 1)));
  return { job: '', status: '', from: utcDay(from), to: utcDay(now) };
}

/** The query string for one page; an empty filter is left out, never sent blank. */
export function jobRunsQuery(filters: JobRunFilters, offset: number, limit = JOB_RUNS_PAGE_SIZE): string {
  const params = new URLSearchParams();
  if (filters.job) params.set('job', filters.job);
  if (filters.status) params.set('status', filters.status);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  return params.toString();
}

/** A range the API would refuse (`from` after `to`); the page says so instead of sending it. */
export function filtersError(filters: JobRunFilters): 'range' | null {
  return filters.from && filters.to && filters.from > filters.to ? 'range' : null;
}

export function jobLabelKey(job: string): string {
  return (JOB_RUN_JOBS as readonly string[]).includes(job) ? `job_${job}` : 'job_unknown';
}

export function statusLabelKey(status: string): string {
  return (JOB_RUN_STATUSES as readonly string[]).includes(status) ? `status_${status}` : 'status_unknown';
}

export type StatusTone = 'ok' | 'bad' | 'neutral' | 'progress';

export function statusTone(status: string): StatusTone {
  if (status === 'completed') return 'ok';
  if (status === 'failed') return 'bad';
  if (status === 'in_progress') return 'progress';
  return 'neutral';
}

/** Locale key of a job's one-line purpose; an unknown job has none. */
export function jobDescriptionKey(job: string): string | null {
  return (JOB_RUN_JOBS as readonly string[]).includes(job) ? `job_desc_${job}` : null;
}

/** Locale key of the result chip; `null` renders no chip. */
export function resultLabelKey(result: string | null | undefined): string | null {
  return (JOB_RUN_RESULTS as readonly string[]).includes(result ?? '') ? `result_${result}` : null;
}

export function issueLabelKey(issue: string): string {
  return `issue_${issue}`;
}

/** Chip colours: the app's status greens, ambers and reds. */
export function resultChipColors(result: JobRunResult): { color: string; background: string } {
  if (result === 'success') return { color: '#067647', background: '#ecfdf3' };
  if (result === 'warning') return { color: '#93370d', background: '#fffaeb' };
  return { color: '#b42318', background: '#fef3f2' };
}

/** `1m 05s`; `null` (still running, or no finish time) reads as an em dash. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return `${m}m ${String(rest).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

/**
 * The HTTP status the endpoint answered with. It is never an exit code, so it is only
 * ever shown under that name; the two nightly logs store none and read as an em dash.
 */
export function formatHttpStatus(status: number | null | undefined): string {
  return typeof status === 'number' ? String(status) : '—';
}

/** The source's own counters, in the order the source stored them. */
export function detailEntries(details: Record<string, unknown> | null | undefined): Array<{ key: string; value: string }> {
  if (!details || typeof details !== 'object') return [];
  return Object.entries(details)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([key, v]) => ({ key, value: typeof v === 'object' ? JSON.stringify(v) : String(v) }));
}

export function pageCount(total: number, limit = JOB_RUNS_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / limit));
}
