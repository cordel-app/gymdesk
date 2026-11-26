'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { formatGymDateTime } from '@/lib/gymFormat';
import { secondaryBtnSmall } from '@/components/formChrome';
import { FilterBar, FilterField, filterControlStyle, filterButtonStyle } from '@/components/FilterBar';
import { listNameBadgeStyle, listNameBadgeAccentStyle } from '@/components/listChrome';
import {
  JOB_RUN_JOBS, JOB_RUN_STATUSES, JOB_RUNS_PAGE_SIZE, type JobRun, type JobRunFilters, type JobRunsResponse,
  defaultJobRunFilters, filtersError, formatDuration, jobLabelKey,
  jobDescriptionKey, updatedItemsLabel, jobRunsQuery, pageCount, resultChipColors, resultLabelKey, statusLabelKey, statusTone,
  JOB_RUN_OPTIONAL_COLUMNS, JOB_RUN_COLUMNS_STORAGE_KEY, type JobRunOptionalColumn,
  fetchAllJobRuns, isNumericJobRunColumn, jobRunColumnLabelKey, jobRunExportRow, jobRunsExportFileName,
  jobRunsGrid, jobRunsMinWidth, optionalColumnValue, parseStoredJobRunColumns, toggleJobRunColumn,
  visibleJobRunColumns, warningKeys,
} from '@/lib/jobRuns';
import { buildXlsx, XLSX_MIME } from '@/lib/xlsxWorkbook';
import { Tabs } from '@/components/Tabs';
import { JobRunLog } from '@/components/jobs/JobRunLog';
import { JobsOverview } from '@/components/jobs/JobsOverview';
import { DEFAULT_JOBS_PAGE_TAB, JOBS_PAGE_TABS, type JobsPageTab } from '@/lib/jobRuns';

/**
 * #1996 stage 3 — Cordel → Jobs: the execution history of the system jobs, newest first.
 *
 * Read-only: the runs are written by the jobs themselves (stage 1) and read through
 * `GET /platform/job-runs` (stage 2). The default range is the last 7 UTC days; the
 * dates filter on the UTC day a run started. What is worded and how lives in
 * `lib/jobRuns.ts`.
 */
export default function CordelJobsPage() {
  const t = useTranslations('job_runs');
  const locale = useLocale();
  const fmt = useGymFormatSettings();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { isSuperadmin, loading: gymLoading } = useGym();

  const [tab, setTab] = useState<JobsPageTab>(DEFAULT_JOBS_PAGE_TAB);
  const [filters, setFilters] = useState<JobRunFilters>(() => defaultJobRunFilters());
  const [applied, setApplied] = useState<JobRunFilters>(filters);
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<JobRunsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [columns, setColumns] = useState<JobRunOptionalColumn[]>([]);
  const [exporting, setExporting] = useState(false);
  const [exportFailed, setExportFailed] = useState(false);

  // #3171: the optional columns this browser last chose (a per-viewer convenience).
  useEffect(() => {
    try { setColumns(parseStoredJobRunColumns(window.localStorage.getItem(JOB_RUN_COLUMNS_STORAGE_KEY))); } catch { /* no storage */ }
  }, []);

  function toggleColumn(column: JobRunOptionalColumn) {
    setColumns((prev) => {
      const next = toggleJobRunColumn(prev, column);
      try { window.localStorage.setItem(JOB_RUN_COLUMNS_STORAGE_KEY, JSON.stringify(next)); } catch { /* no storage */ }
      return next;
    });
  }

  /** #3171: every run matching the applied filters, in exactly the visible columns. */
  async function exportToExcel() {
    setExporting(true);
    setExportFailed(false);
    try {
      const runs = await fetchAllJobRuns(applied, (q) => apiFetch(`/platform/job-runs?${q}`) as Promise<JobRunsResponse>);
      const visible = visibleJobRunColumns(columns);
      const ctx = { t: (k: string) => t(k), started: (r: JobRun) => formatGymDateTime(r.started_at, fmt) };
      const bytes = buildXlsx(t('title'), visible.map((c) => t(jobRunColumnLabelKey(c))), runs.map((r) => jobRunExportRow(r, visible, ctx)));
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: XLSX_MIME }));
      const a = document.createElement('a');
      a.href = url;
      a.download = jobRunsExportFileName(applied);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setExportFailed(true);
    } finally {
      setExporting(false);
    }
  }

  useEffect(() => {
    if (!gymLoading && !isSuperadmin) router.replace(`/${locale}`);
  }, [gymLoading, isSuperadmin]);

  useEffect(() => {
    if (gymLoading || !isSuperadmin) return;
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    (async () => {
      try {
        const res = (await apiFetch(`/platform/job-runs?${jobRunsQuery(applied, offset)}`)) as JobRunsResponse;
        if (!cancelled) setData(res);
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [gymLoading, isSuperadmin, applied, offset]);

  function apply() {
    if (filtersError(filters)) return;
    setOffset(0);
    setOpen(new Set());
    setApplied(filters);
  }

  function clear() {
    const defaults = defaultJobRunFilters();
    setFilters(defaults);
    setOffset(0);
    setOpen(new Set());
    setApplied(defaults);
  }

  function toggle(id: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  if (gymLoading || !isSuperadmin) return null;

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const pages = pageCount(total);
  const page = Math.floor(offset / JOB_RUNS_PAGE_SIZE) + 1;
  const rangeError = filtersError(filters);

  return (
    <div>
      <h1 style={{ margin: '0 0 6px' }}>{t('title')}</h1>
      <p style={{ margin: '0 0 16px', color: '#666', maxWidth: 720 }}>{t('intro')}</p>

      <Tabs tabs={JOBS_PAGE_TABS} active={tab} onChange={setTab} label={(k) => t(k)} ariaLabel={t('title')} />

      {tab === 'jobs' ? <JobsOverview t={t} /> : (<>
      <FilterBar>
        <FilterField label={t('filter_job')} htmlFor="jobs-job">
          <select
            id="jobs-job"
            style={filterControlStyle}
            value={filters.job}
            onChange={(e) => setFilters({ ...filters, job: e.target.value as JobRunFilters['job'] })}
          >
            <option value="">{t('all_jobs')}</option>
            {JOB_RUN_JOBS.map((j) => <option key={j} value={j}>{t(jobLabelKey(j))}</option>)}
          </select>
        </FilterField>
        <FilterField label={t('filter_status')} htmlFor="jobs-status">
          <select
            id="jobs-status"
            style={filterControlStyle}
            value={filters.status}
            onChange={(e) => setFilters({ ...filters, status: e.target.value as JobRunFilters['status'] })}
          >
            <option value="">{t('all_statuses')}</option>
            {JOB_RUN_STATUSES.map((s) => <option key={s} value={s}>{t(statusLabelKey(s))}</option>)}
          </select>
        </FilterField>
        <FilterField label={t('filter_from')} htmlFor="jobs-from">
          <input
            id="jobs-from" type="date" style={filterControlStyle} value={filters.from}
            onChange={(e) => setFilters({ ...filters, from: e.target.value })}
          />
        </FilterField>
        <FilterField label={t('filter_to')} htmlFor="jobs-to">
          <input
            id="jobs-to" type="date" style={filterControlStyle} value={filters.to}
            onChange={(e) => setFilters({ ...filters, to: e.target.value })}
          />
        </FilterField>
        <button type="button" style={{ ...filterButtonStyle, opacity: rangeError ? 0.5 : 1 }} disabled={!!rangeError} onClick={apply}>
          {t('apply')}
        </button>
        <button type="button" style={filterButtonStyle} onClick={clear}>{t('clear')}</button>
      </FilterBar>
      <p style={{ margin: '-8px 0 12px', color: '#888', fontSize: 12.5 }}>{t('utc_hint')}</p>
      {rangeError && <p role="alert" style={{ color: '#b42318' }}>{t('range_invalid')}</p>}

      {failed && <p role="alert" style={{ color: '#b42318' }}>{t('load_failed')}</p>}
      {loading && !data && !failed && <p style={{ color: '#888' }}>{t('loading')}</p>}
      {data && !failed && items.length === 0 && <p style={{ color: '#444' }}>{t('empty')}</p>}

      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        {exportFailed && <span role="alert" style={{ color: '#b42318', fontSize: 13 }}>{t('export_failed')}</span>}
        <button
          type="button"
          style={{ ...secondaryBtnSmall, opacity: exporting || !data || total === 0 ? 0.5 : 1 }}
          disabled={exporting || !data || total === 0}
          onClick={exportToExcel}
        >
          {exporting ? t('exporting') : t('export_excel')}
        </button>
        <ColumnSettings selected={columns} onToggle={toggleColumn} t={t} />
      </div>

      <div style={{ overflowX: 'auto', opacity: loading && data ? 0.6 : 1 }}>
       <div style={{ minWidth: jobRunsMinWidth(columns) }}>
        {items.length > 0 && (
          <div role="row" style={{
            display: 'grid', gridTemplateColumns: jobRunsGrid(columns), gap: 10, padding: '8px 14px',
            fontSize: 12, fontWeight: 600, color: '#666', borderBottom: '1px solid #ddd',
          }}>
            <span>{t('col_job')}</span>
            <span>{t('col_description')}</span>
            <span style={{ textAlign: 'right' }}>{t('col_updated')}</span>
            <span>{t('col_date')}</span>
            <span>{t('col_duration')}</span>
            <span style={{ textAlign: 'right' }}>{t('col_status')}</span>
            {columns.map((c) => (
              <span key={c} style={isNumericJobRunColumn(c) ? { textAlign: 'right' } : undefined}>{t(jobRunColumnLabelKey(c))}</span>
            ))}
          </div>
        )}
        {items.map((run) => (
          <RunCard
            key={run.id}
            run={run}
            expanded={open.has(run.id)}
            onToggle={() => toggle(run.id)}
            columns={columns}
            t={t}
            started={formatGymDateTime(run.started_at, fmt)}
          />
        ))}
       </div>
      </div>

      {total > JOB_RUNS_PAGE_SIZE && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
          <button type="button" style={secondaryBtnSmall} disabled={offset === 0 || loading}
            onClick={() => setOffset(Math.max(0, offset - JOB_RUNS_PAGE_SIZE))}>{t('previous')}</button>
          <span style={{ color: '#666', fontSize: 13 }}>{t('page_of', { page, pages, total })}</span>
          <button type="button" style={secondaryBtnSmall} disabled={page >= pages || loading}
            onClick={() => setOffset(offset + JOB_RUNS_PAGE_SIZE)}>{t('next')}</button>
        </div>
      )}
      </>)}
    </div>
  );
}

/** #3171: the compact column-settings control at the right of the table. */
function ColumnSettings({ selected, onToggle, t }: {
  selected: JobRunOptionalColumn[]; onToggle: (c: JobRunOptionalColumn) => void; t: (k: string, v?: any) => string;
}) {
  const [show, setShow] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!show) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setShow(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShow(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [show]);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        style={secondaryBtnSmall}
        aria-haspopup="true"
        aria-expanded={show}
        aria-label={t('columns_settings')}
        title={t('columns_settings')}
        onClick={() => setShow((v) => !v)}
      >
        <span aria-hidden="true">⚙</span> {t('columns')}{selected.length ? ` (${selected.length})` : ''}
      </button>
      {show && (
        <div role="group" aria-label={t('columns_optional')} style={{
          position: 'absolute', right: 0, top: 'calc(100% + 4px)', zIndex: 20, minWidth: 220,
          background: 'var(--gd-card-bg, #fff)', border: '1px solid #ddd', borderRadius: 8,
          boxShadow: '0 4px 16px rgba(0,0,0,0.12)', padding: '10px 12px',
        }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#666', marginBottom: 6 }}>{t('columns_optional')}</div>
          {JOB_RUN_OPTIONAL_COLUMNS.map((c) => (
            <label key={c} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', fontSize: 13.5, cursor: 'pointer' }}>
              <input type="checkbox" checked={selected.includes(c)} onChange={() => onToggle(c)} />
              {t(jobRunColumnLabelKey(c))}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function optionalCell(run: JobRun, column: JobRunOptionalColumn, t: (k: string) => string): string {
  if (column === 'warnings') {
    const keys = warningKeys(run);
    return keys.length ? keys.map((k) => t(k)).join('; ') : '—';
  }
  const v = optionalColumnValue(run, column);
  return v === null ? '—' : String(v);
}

function RunCard({ run, expanded, onToggle, columns, t, started }: {
  run: JobRun; expanded: boolean; onToggle: () => void; columns: JobRunOptionalColumn[];
  t: (k: string, v?: any) => string; started: string;
}) {
  const tone = statusTone(run.status);
  const badge = tone === 'ok' || tone === 'progress' ? listNameBadgeAccentStyle : listNameBadgeStyle;
  const descKey = jobDescriptionKey(run.job);
  const resultKey = resultLabelKey(run.result);
  return (
    <div style={{ borderBottom: '1px solid #eee' }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        style={{
          all: 'unset', boxSizing: 'border-box', width: '100%', cursor: 'pointer', display: 'grid',
          gridTemplateColumns: jobRunsGrid(columns), alignItems: 'center', gap: 10, padding: '8px 14px',
        }}
      >
        <span style={{ fontWeight: 600 }}>
          <span aria-hidden="true">{expanded ? '▾' : '▸'} </span>{t(jobLabelKey(run.job))}
        </span>
        <span style={{ color: '#888', fontSize: 12.5 }}>{descKey ? t(descKey) : ''}</span>
        <span style={{ textAlign: 'right' }}>{updatedItemsLabel(run)}</span>
        <span style={{ color: '#666', fontSize: 13 }}>{started}</span>
        <span style={{ color: '#888', fontSize: 13 }}>{formatDuration(run.duration_seconds)}</span>
        <span style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <span style={{ ...badge, ...(tone === 'bad' ? { color: '#b42318' } : null) }}>{t(statusLabelKey(run.status))}</span>
          {resultKey && run.result && (
            <span style={{ ...listNameBadgeStyle, ...resultChipColors(run.result) }}>{t(resultKey)}</span>
          )}
        </span>
        {columns.map((c) => (
          <span key={c} style={{
            fontSize: 13, color: '#444', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            ...(isNumericJobRunColumn(c) ? { textAlign: 'right' as const } : null),
          }} title={optionalCell(run, c, t)}>{optionalCell(run, c, t)}</span>
        ))}
      </button>
      {expanded && (
        <div style={{ padding: '0 14px 14px 38px', fontSize: 13.5 }}>
          <JobRunLog run={run} t={t} started={started} />
        </div>
      )}
    </div>
  );
}
