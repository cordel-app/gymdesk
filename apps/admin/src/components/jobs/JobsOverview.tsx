'use client';

import React, { useEffect, useState } from 'react';
import { useApiClient } from '@/lib/apiClient';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { formatGymDateTime } from '@/lib/gymFormat';
import { primaryBtnSmall } from '@/components/ui';
import {
  type JobRun, type SystemJobOverview, jobDescriptionKey, jobLabelKey, manualRunErrorKey,
} from '@/lib/jobRuns';
import { JobRunLog } from './JobRunLog';

/**
 * #3471 — Cordel → Jobs → Jobs: every registered system job, its latest execution (manual
 * or scheduled — one history, `GET /platform/job-runs/jobs`) and a Play action that starts
 * it through the API (`POST …/jobs/:job/run`). Whether a job may be started is the API's
 * answer; the client holds no secret and decides nothing.
 */
const GRID = 'minmax(180px, 1.2fr) minmax(220px, 2fr) minmax(150px, 1fr) 72px';

type Feedback = { tone: 'ok' | 'bad'; key: string };

export function JobsOverview({ t }: { t: (k: string, v?: any) => string }) {
  const { apiFetch } = useApiClient();
  const fmt = useGymFormatSettings();
  const [items, setItems] = useState<SystemJobOverview[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [feedback, setFeedback] = useState<Record<string, Feedback>>({});

  async function load() {
    try {
      const res = (await apiFetch('/platform/job-runs/jobs')) as { items: SystemJobOverview[] };
      setItems(res.items);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }

  useEffect(() => { load(); }, []);

  function setLatest(job: string, run: JobRun | null | undefined) {
    if (run === undefined) return;
    setItems((prev) => prev?.map((i) => (i.job === job ? { ...i, latest_run: run } : i)) ?? prev);
  }

  async function runNow(job: string) {
    if (running.has(job)) return;
    setRunning((prev) => new Set(prev).add(job));
    setFeedback((prev) => { const next = { ...prev }; delete next[job]; return next; });
    try {
      const res = (await apiFetch(`/platform/job-runs/jobs/${job}/run`, { method: 'POST' })) as { latest_run: JobRun | null };
      setLatest(job, res.latest_run);
      setFeedback((prev) => ({ ...prev, [job]: { tone: 'ok', key: 'run_success' } }));
    } catch (err: any) {
      setLatest(job, err?.body?.latest_run);
      setFeedback((prev) => ({ ...prev, [job]: { tone: 'bad', key: manualRunErrorKey(err?.body?.error) } }));
    } finally {
      setRunning((prev) => { const next = new Set(prev); next.delete(job); return next; });
    }
  }

  function toggle(job: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(job)) next.delete(job); else next.add(job);
      return next;
    });
  }

  if (failed) return <p role="alert" style={{ color: '#b42318' }}>{t('load_failed')}</p>;
  if (!items) return <p style={{ color: '#888' }}>{t('loading')}</p>;

  return (
    <div style={{ overflowX: 'auto' }}>
      <div style={{ minWidth: 680 }}>
        <div role="row" style={{
          display: 'grid', gridTemplateColumns: GRID, gap: 10, padding: '8px 14px',
          fontSize: 12, fontWeight: 600, color: '#666', borderBottom: '1px solid #ddd',
        }}>
          <span>{t('col_name')}</span>
          <span>{t('col_description')}</span>
          <span>{t('col_last_run')}</span>
          <span style={{ textAlign: 'right' }}>{t('col_play')}</span>
        </div>
        {items.map((item) => {
          const expanded = open.has(item.job);
          const descKey = jobDescriptionKey(item.job);
          const busy = running.has(item.job) || item.running;
          const run = item.latest_run;
          const started = run ? formatGymDateTime(run.started_at, fmt) : '';
          const fb = feedback[item.job];
          const label = t(jobLabelKey(item.job));
          return (
            <div key={item.job} style={{ borderBottom: '1px solid #eee' }}>
              <div style={{ display: 'grid', gridTemplateColumns: GRID, alignItems: 'center', gap: 10, padding: '8px 14px' }}>
                <button
                  type="button"
                  onClick={() => toggle(item.job)}
                  aria-expanded={expanded}
                  style={{ all: 'unset', cursor: 'pointer', fontWeight: 600 }}
                >
                  <span aria-hidden="true">{expanded ? '▾' : '▸'} </span>{label}
                </button>
                <span style={{ color: '#888', fontSize: 12.5 }}>{descKey ? t(descKey) : ''}</span>
                <span style={{ color: '#666', fontSize: 13 }}>{run ? started : t('never_run')}</span>
                <span style={{ textAlign: 'right' }}>
                  <button
                    type="button"
                    style={{ ...primaryBtnSmall(), opacity: !item.manual || busy ? 0.5 : 1, cursor: !item.manual || busy ? 'not-allowed' : 'pointer' }}
                    disabled={!item.manual || busy}
                    aria-label={t('run_now_aria', { job: label })}
                    title={item.manual ? (busy ? t('running') : t('run_now')) : t('run_not_manual')}
                    onClick={() => runNow(item.job)}
                  >
                    {busy ? '…' : <span aria-hidden="true">▶</span>}
                  </button>
                </span>
              </div>
              {fb && (
                <p role={fb.tone === 'bad' ? 'alert' : 'status'} style={{
                  margin: '0 14px 8px 38px', fontSize: 13, color: fb.tone === 'bad' ? '#b42318' : '#067647',
                }}>{t(fb.key)}</p>
              )}
              {expanded && (
                <div style={{ padding: '0 14px 14px 38px', fontSize: 13.5 }}>
                  {run
                    ? <JobRunLog run={run} t={t} started={started} />
                    : <p style={{ margin: 0, color: '#888' }}>{t('never_run_log')}</p>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
