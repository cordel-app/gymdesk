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
  'assignment_lifecycle',
  'billing_window_maintenance',
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
  /** #3009: `processed = updated + skipped`; `null` when the run stored nothing to count from. */
  metrics?: JobMetrics | null;
}

export interface JobMetrics {
  processed: number;
  updated: number;
  skipped: number;
}

/** The Updated Items cell: the updated count, or an em dash where the run kept no metrics. */
export function updatedItemsLabel(run: Pick<JobRun, 'metrics'>): string {
  return run.metrics ? String(run.metrics.updated) : '—';
}

/** The summary shown at the top of an expanded run; `null` when there is nothing to show. */
export function metricsSummary(run: Pick<JobRun, 'metrics'>): Array<{ key: 'processed' | 'updated' | 'skipped'; value: number }> | null {
  const m = run.metrics;
  if (!m) return null;
  return [
    { key: 'processed', value: m.processed },
    { key: 'updated', value: m.updated },
    { key: 'skipped', value: m.skipped },
  ];
}

/** The grid of the table header and every row, so the columns stay aligned. */
export const JOB_RUNS_GRID = 'minmax(120px,1.1fr) minmax(180px,2.4fr) 90px minmax(140px,1fr) 80px minmax(150px,1fr)';

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
    .filter(([k]) => k !== 'metrics')
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([key, v]) => ({ key, value: typeof v === 'object' ? JSON.stringify(v) : String(v) }));
}

export function pageCount(total: number, limit = JOB_RUNS_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / limit));
}

// ─── #3171: optional detail columns and the Excel export ─────────────────────

/** The default columns: always shown, in this order, never hidden by the selector. */
export const JOB_RUN_DEFAULT_COLUMNS = ['job', 'description', 'updated', 'date', 'duration', 'status'] as const;
export type JobRunDefaultColumn = (typeof JOB_RUN_DEFAULT_COLUMNS)[number];

/**
 * The optional detail columns, in the order they are offered and shown (after the
 * defaults). Each is a field the expanded run already shows: its metrics summary, its
 * source counters, the HTTP status, the error summary and the warnings.
 */
export const JOB_RUN_OPTIONAL_COLUMNS = [
  'processed', 'succeeded', 'failed', 'waived', 'created', 'skipped', 'notified',
  'run_date', 'http_status', 'error_summary', 'warnings',
] as const;
export type JobRunOptionalColumn = (typeof JOB_RUN_OPTIONAL_COLUMNS)[number];
export type JobRunColumn = JobRunDefaultColumn | JobRunOptionalColumn;

/** Locale key of a column heading (`job_runs.col_<column>`), shared by the table and the export. */
export function jobRunColumnLabelKey(column: JobRunColumn): string {
  return `col_${column}`;
}

/** Where the page remembers the selection, per browser (a convenience, never shared state). */
export const JOB_RUN_COLUMNS_STORAGE_KEY = 'gd-job-runs-columns';

/** The stored selection read back: known columns only, in declaration order; garbage is none. */
export function parseStoredJobRunColumns(raw: string | null | undefined): JobRunOptionalColumn[] {
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return JOB_RUN_OPTIONAL_COLUMNS.filter((c) => parsed.includes(c));
}

/** Adds or hides one optional column, keeping the declaration order. */
export function toggleJobRunColumn(selected: readonly JobRunOptionalColumn[], column: JobRunOptionalColumn): JobRunOptionalColumn[] {
  const has = selected.includes(column);
  return JOB_RUN_OPTIONAL_COLUMNS.filter((c) => (c === column ? !has : selected.includes(c)));
}

/** Every visible column: the defaults, then the selected optional ones. */
export function visibleJobRunColumns(selected: readonly JobRunOptionalColumn[]): JobRunColumn[] {
  return [...JOB_RUN_DEFAULT_COLUMNS, ...JOB_RUN_OPTIONAL_COLUMNS.filter((c) => selected.includes(c))];
}

const OPTIONAL_COLUMN_TRACK: Record<JobRunOptionalColumn, string> = {
  processed: '90px', succeeded: '90px', failed: '80px', waived: '80px', created: '80px',
  skipped: '80px', notified: '80px', run_date: '110px', http_status: '90px',
  error_summary: 'minmax(180px,2fr)', warnings: 'minmax(160px,1.5fr)',
};

/** The grid of the header and every row for a selection; with none it is `JOB_RUNS_GRID`. */
export function jobRunsGrid(selected: readonly JobRunOptionalColumn[]): string {
  const extra = JOB_RUN_OPTIONAL_COLUMNS.filter((c) => selected.includes(c)).map((c) => OPTIONAL_COLUMN_TRACK[c]);
  return [JOB_RUNS_GRID, ...extra].join(' ');
}

/** The minimum width the table scrolls at, so added columns never squeeze the defaults. */
export function jobRunsMinWidth(selected: readonly JobRunOptionalColumn[]): number {
  return 820 + selected.length * 110;
}

/** Numeric optional columns are right-aligned, like Updated Items. */
export function isNumericJobRunColumn(column: JobRunColumn): boolean {
  return column === 'updated' || ['processed', 'succeeded', 'failed', 'waived', 'created', 'skipped', 'notified', 'http_status'].includes(column);
}

function detailValue(value: unknown): string | number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') return value;
  return null;
}

/**
 * The value of an optional column for one run, or `null` (an em dash) when the run did
 * not record it. Processed and Skipped are the run's metrics (the expanded summary) and
 * fall back to the source counter of that name; the rest are the source's own counters.
 * Warnings are locale keys the caller resolves.
 */
export function optionalColumnValue(
  run: Pick<JobRun, 'metrics' | 'details' | 'http_status' | 'error_summary' | 'issues'>,
  column: Exclude<JobRunOptionalColumn, 'warnings'>,
): string | number | null {
  const details = run.details ?? {};
  switch (column) {
    case 'processed': return run.metrics ? run.metrics.processed : detailValue(details.processed);
    case 'skipped': return run.metrics ? run.metrics.skipped : detailValue(details.skipped);
    case 'http_status': return typeof run.http_status === 'number' ? run.http_status : null;
    case 'error_summary': return run.error_summary && run.error_summary.trim() !== '' ? run.error_summary : null;
    default: return detailValue(details[column]);
  }
}

/** The warnings of a run as locale keys; empty reads as an em dash. */
export function warningKeys(run: Pick<JobRun, 'issues'>): string[] {
  return (run.issues ?? []).map(issueLabelKey);
}

/** The page size the export reads with: the API's own maximum. */
export const JOB_RUNS_EXPORT_PAGE_SIZE = 100;

/**
 * Reads every run matching the applied filters, page by page, through the same route
 * and query the table uses. Stops at the reported total or at an empty page.
 */
export async function fetchAllJobRuns(
  filters: JobRunFilters,
  fetchPage: (query: string) => Promise<JobRunsResponse>,
): Promise<JobRun[]> {
  const all: JobRun[] = [];
  let offset = 0;
  for (;;) {
    const res = await fetchPage(jobRunsQuery(filters, offset, JOB_RUNS_EXPORT_PAGE_SIZE));
    all.push(...res.items);
    offset += res.items.length;
    if (res.items.length === 0 || offset >= res.total) break;
  }
  return all;
}

export interface JobRunExportContext {
  t: (key: string) => string;
  /** The Date / Time cell, formatted as the table formats it. */
  started: (run: JobRun) => string;
}

/** One run as the cells of the visible columns, worded exactly as the table words them. */
export function jobRunExportRow(run: JobRun, columns: readonly JobRunColumn[], ctx: JobRunExportContext): Array<string | number> {
  const dash = (v: string | number | null): string | number => (v === null ? '—' : v);
  return columns.map((column) => {
    switch (column) {
      case 'job': return ctx.t(jobLabelKey(run.job));
      case 'description': {
        const key = jobDescriptionKey(run.job);
        return key ? ctx.t(key) : '';
      }
      case 'updated': return run.metrics ? run.metrics.updated : '—';
      case 'date': return ctx.started(run);
      case 'duration': return formatDuration(run.duration_seconds);
      case 'status': {
        const resultKey = resultLabelKey(run.result);
        const status = ctx.t(statusLabelKey(run.status));
        return resultKey ? `${status} · ${ctx.t(resultKey)}` : status;
      }
      case 'warnings': {
        const keys = warningKeys(run);
        return keys.length ? keys.map(ctx.t).join('; ') : '—';
      }
      default: return dash(optionalColumnValue(run, column));
    }
  });
}

/** `jobs-2026-11-15_2026-11-22.xlsx`, from the applied range. */
export function jobRunsExportFileName(filters: JobRunFilters): string {
  const range = [filters.from, filters.to].filter(Boolean).join('_');
  return `jobs${range ? `-${range}` : ''}.xlsx`;
}
