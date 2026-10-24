import { describe, expect, it } from 'vitest';
import { normalizeJobRun, parseJobRunFilter, utcIso } from '../domain/jobRuns';

describe('parseJobRunFilter (#1996)', () => {
  it('defaults to the first page with no filter', () => {
    expect(parseJobRunFilter({})).toEqual({
      ok: true,
      filter: { job: null, status: null, from: null, to: null, limit: 25, offset: 0 },
    });
  });
  it('widens the dates to the whole UTC day', () => {
    const r = parseJobRunFilter({ from: '2026-10-01', to: '2026-10-07' });
    expect(r.ok && r.filter).toMatchObject({ from: '2026-10-01 00:00:00', to: '2026-10-07 23:59:59' });
  });
  it('refuses unknown values', () => {
    expect(parseJobRunFilter({ job: 'x' }).ok).toBe(false);
    expect(parseJobRunFilter({ from: '2026-02-30' }).ok).toBe(false);
    expect(parseJobRunFilter({ limit: '1.5' }).ok).toBe(false);
  });
});

describe('normalizeJobRun (#1996)', () => {
  it('derives the duration and reads UTC datetimes', () => {
    const run = normalizeJobRun({
      source: 'job_run_log', source_id: 7, job: 'booking_reminders', status: 'completed',
      started_at: '2026-10-01 10:00:00', finished_at: '2026-10-01 10:00:05',
      http_status: 200, error_summary: null, details: '{"created":2}',
    });
    expect(run).toMatchObject({ id: 'job_run_log:7', duration_seconds: 5, details: { created: 2 } });
    expect(utcIso(new Date('2026-10-01T10:00:00Z'))).toBe('2026-10-01T10:00:00.000Z');
  });
  it('tolerates a missing or malformed details value', () => {
    const base = {
      source: 'job_run_log', source_id: 1, job: 'billing_cleanup', status: 'in_progress',
      started_at: '2026-10-01 10:00:00', finished_at: null, http_status: null, error_summary: null,
    };
    expect(normalizeJobRun({ ...base, details: null }).details).toEqual({});
    expect(normalizeJobRun({ ...base, details: '[1]' }).details).toEqual({});
    expect(normalizeJobRun({ ...base, details: '{bad' }).details).toEqual({});
  });
});
