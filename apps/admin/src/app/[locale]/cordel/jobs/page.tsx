'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { formatGymDateTime } from '@/lib/gymFormat';
import { cardSurfaceStyle } from '@/components/ui';
import { secondaryBtnSmall } from '@/components/formChrome';
import { FilterBar, FilterField, filterControlStyle, filterButtonStyle } from '@/components/FilterBar';
import { listNameBadgeStyle, listNameBadgeAccentStyle } from '@/components/listChrome';
import {
  JOB_RUN_JOBS, JOB_RUN_STATUSES, JOB_RUNS_PAGE_SIZE, type JobRun, type JobRunFilters, type JobRunsResponse,
  defaultJobRunFilters, detailEntries, filtersError, formatDuration, formatHttpStatus, jobLabelKey,
  issueLabelKey, jobDescriptionKey, jobRunsQuery, pageCount, resultChipColors, resultLabelKey, statusLabelKey, statusTone,
} from '@/lib/jobRuns';

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

  const [filters, setFilters] = useState<JobRunFilters>(() => defaultJobRunFilters());
  const [applied, setApplied] = useState<JobRunFilters>(filters);
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<JobRunsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());

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

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, opacity: loading && data ? 0.6 : 1 }}>
        {items.map((run) => (
          <RunCard
            key={run.id}
            run={run}
            expanded={open.has(run.id)}
            onToggle={() => toggle(run.id)}
            t={t}
            started={formatGymDateTime(run.started_at, fmt)}
          />
        ))}
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
    </div>
  );
}

function RunCard({ run, expanded, onToggle, t, started }: {
  run: JobRun; expanded: boolean; onToggle: () => void; t: (k: string, v?: any) => string; started: string;
}) {
  const tone = statusTone(run.status);
  const badge = tone === 'ok' || tone === 'progress' ? listNameBadgeAccentStyle : listNameBadgeStyle;
  const entries = detailEntries(run.details);
  const descKey = jobDescriptionKey(run.job);
  const resultKey = resultLabelKey(run.result);
  return (
    <div style={cardSurfaceStyle}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        style={{
          all: 'unset', boxSizing: 'border-box', width: '100%', cursor: 'pointer', display: 'flex',
          flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: '12px 14px',
        }}
      >
        <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontWeight: 600 }}>{t(jobLabelKey(run.job))}</span>
          {descKey && <span style={{ color: '#888', fontSize: 12.5, fontWeight: 400 }}>{t(descKey)}</span>}
        </span>
        <span style={{ ...badge, ...(tone === 'bad' ? { color: '#b42318' } : null) }}>{t(statusLabelKey(run.status))}</span>
        {resultKey && run.result && (
          <span style={{ ...listNameBadgeStyle, ...resultChipColors(run.result) }}>{t(resultKey)}</span>
        )}
        <span style={{ color: '#666', fontSize: 13 }}>{started}</span>
        <span style={{ color: '#888', fontSize: 13 }}>{formatDuration(run.duration_seconds)}</span>
      </button>
      {expanded && (
        <div style={{ padding: '0 14px 14px 38px', fontSize: 13.5 }}>
          <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 14px', margin: 0 }}>
            {descKey && (<><dt style={{ color: '#888' }}>{t('field_purpose')}</dt><dd style={{ margin: 0 }}>{t(descKey)}</dd></>)}
            {resultKey && (<><dt style={{ color: '#888' }}>{t('field_result')}</dt><dd style={{ margin: 0 }}>{t(resultKey)}</dd></>)}
            {(run.issues ?? []).map((i) => (<><dt key={`i-${i}`} style={{ color: '#888' }}>{t('field_warning')}</dt><dd key={`iv-${i}`} style={{ margin: 0, color: '#93370d' }}>{t(issueLabelKey(i))}</dd></>))}
            <dt style={{ color: '#888' }}>{t('field_started')}</dt><dd style={{ margin: 0 }}>{started}</dd>
            <dt style={{ color: '#888' }}>{t('field_duration')}</dt><dd style={{ margin: 0 }}>{formatDuration(run.duration_seconds)}</dd>
            <dt style={{ color: '#888' }}>{t('field_http_status')}</dt><dd style={{ margin: 0 }}>{formatHttpStatus(run.http_status)}</dd>
            {run.error_summary && (<><dt style={{ color: '#888' }}>{t('field_error')}</dt><dd style={{ margin: 0, color: '#b42318' }}>{run.error_summary}</dd></>)}
            {entries.map((e) => (<><dt key={`k-${e.key}`} style={{ color: '#888' }}>{e.key}</dt><dd key={`v-${e.key}`} style={{ margin: 0 }}>{e.value}</dd></>))}
          </dl>
        </div>
      )}
    </div>
  );
}
