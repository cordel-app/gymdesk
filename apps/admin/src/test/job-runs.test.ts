import { describe, it, expect } from 'vitest';
import en from '../../locales/base/en.json';
import es from '../../locales/base/es.json';
import ca from '../../locales/base/ca.json';
import {
  JOB_RUN_JOBS, JOB_RUN_STATUSES, defaultJobRunFilters, detailEntries, filtersError, formatDuration,
  formatHttpStatus, jobLabelKey, jobRunsQuery, pageCount, statusLabelKey, statusTone,
} from '../lib/jobRuns';

describe('Jobs page decisions (#1996 stage 3)', () => {
  it('defaults to the last 7 UTC days, today included', () => {
    const f = defaultJobRunFilters(new Date('2026-10-24T23:30:00Z'));
    expect(f).toEqual({ job: '', status: '', from: '2026-10-18', to: '2026-10-24' });
  });

  it('leaves empty filters out of the query and always pages', () => {
    const q = jobRunsQuery({ job: 'billing_run', status: '', from: '2026-10-18', to: '' }, 25);
    expect(q).toBe('job=billing_run&from=2026-10-18&limit=25&offset=25');
  });

  it('refuses an inverted range before sending it', () => {
    expect(filtersError({ job: '', status: '', from: '2026-10-24', to: '2026-10-18' })).toBe('range');
    expect(filtersError({ job: '', status: '', from: '2026-10-18', to: '2026-10-18' })).toBeNull();
  });

  it('shows durations, and an em dash where there is none', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(42)).toBe('42s');
    expect(formatDuration(65)).toBe('1m 05s');
    expect(formatDuration(3720)).toBe('1h 02m');
  });

  it('never invents an exit code: HTTP status or an em dash', () => {
    expect(formatHttpStatus(200)).toBe('200');
    expect(formatHttpStatus(null)).toBe('—');
  });

  it('tones statuses and lists details without blanks', () => {
    expect(statusTone('failed')).toBe('bad');
    expect(statusTone('completed')).toBe('ok');
    expect(statusTone('skipped')).toBe('neutral');
    expect(detailEntries({ processed: 3, note: null, x: { a: 1 } })).toEqual([
      { key: 'processed', value: '3' }, { key: 'x', value: '{"a":1}' },
    ]);
    expect(pageCount(0)).toBe(1);
    expect(pageCount(26)).toBe(2);
  });

  it('has a label in every language for every job, status and fixed key', () => {
    for (const dict of [en, es, ca] as any[]) {
      const ns = dict.job_runs;
      for (const j of JOB_RUN_JOBS) expect(ns[jobLabelKey(j)], j).toBeTruthy();
      for (const s of JOB_RUN_STATUSES) expect(ns[statusLabelKey(s)], s).toBeTruthy();
      expect(ns[jobLabelKey('nope')]).toBeTruthy();
      expect(ns[statusLabelKey('nope')]).toBeTruthy();
      expect(dict.nav.jobs).toBeTruthy();
    }
  });
});
