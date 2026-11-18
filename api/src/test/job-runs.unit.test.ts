import { describe, expect, it } from 'vitest';
import {
  buildJobMetrics, classifyJobRun, jobRunMetrics, normalizeJobRun, parseJobRunFilter, sumJobMetrics, utcIso,
} from '../domain/jobRuns';

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

describe('classifyJobRun (#2156)', () => {
  it('a failed run is an Error whatever it stored', () => {
    expect(classifyJobRun('billing_cleanup', 'failed', {})).toEqual({ result: 'error', issues: [] });
  });
  it('a completed run with clean counters is a Success', () => {
    expect(classifyJobRun('billing_run', 'completed', { processed: 3, failed: 0 }).result).toBe('success');
    expect(classifyJobRun('promotion_lifecycle', 'completed', { expired: 0 }).result).toBe('success');
  });
  it('failed records, per-gym failures and a capped batch are Warnings', () => {
    expect(classifyJobRun('billing_run', 'completed', { processed: 3, failed: 1 }))
      .toEqual({ result: 'warning', issues: ['failed_records'] });
    expect(classifyJobRun('booking_reminders', 'completed', { created: 1, failures: [{ gym_id: 'g' }], capped: true }))
      .toEqual({ result: 'warning', issues: ['partial_failures', 'capped'] });
  });
  it('does not invent a result for history without counters, or for unfinished runs', () => {
    expect(classifyJobRun('billing_cleanup', 'completed', {}).result).toBeNull();
    expect(classifyJobRun('billing_cleanup', 'in_progress', { a: 1 }).result).toBeNull();
    expect(classifyJobRun('billing_cleanup', 'skipped', { a: 1 }).result).toBeNull();
  });
});

describe('job processing metrics (#3009)', () => {
  it('derives processed from updated + skipped, so the invariant always holds', () => {
    expect(buildJobMetrics(3, 2)).toEqual({ processed: 5, updated: 3, skipped: 2 });
    expect(buildJobMetrics(0)).toEqual({ processed: 0, updated: 0, skipped: 0 });
    expect(buildJobMetrics(4)).toEqual({ processed: 4, updated: 4, skipped: 0 });
    expect(buildJobMetrics(0, 6)).toEqual({ processed: 6, updated: 0, skipped: 6 });
  });
  it('aggregates the categories of one job', () => {
    expect(sumJobMetrics([buildJobMetrics(2, 1), buildJobMetrics(3), buildJobMetrics(0, 4)]))
      .toEqual({ processed: 10, updated: 5, skipped: 5 });
  });
  it('reads the metrics a job stored, and rejects ones that break the invariant', () => {
    expect(jobRunMetrics('promotion_lifecycle', { expired: 1, metrics: { processed: 5, updated: 1, skipped: 4 } }))
      .toEqual({ processed: 5, updated: 1, skipped: 4 });
    expect(jobRunMetrics('promotion_lifecycle', { metrics: { processed: 5, updated: 1, skipped: 1 } })).toBeNull();
  });
  it('derives the two nightly logs from their own counters and never estimates', () => {
    expect(jobRunMetrics('billing_run', { processed: 10, succeeded: 6, failed: 2, waived: 1 }))
      .toEqual({ processed: 10, updated: 7, skipped: 3 });
    expect(jobRunMetrics('recurring_bookings', { processed: 8, created: 5, skipped: 2, failed: 1 }))
      .toEqual({ processed: 8, updated: 5, skipped: 3 });
    expect(jobRunMetrics('billing_run', { processed: 2, succeeded: 5, waived: 0 })).toBeNull();
    expect(jobRunMetrics('promotion_lifecycle', { expired: 2 })).toBeNull();
  });
  it('is reported on the normalized run', () => {
    const run = normalizeJobRun({
      source: 'job_run_log', source_id: 1, job: 'assignment_lifecycle', status: 'completed',
      started_at: '2026-10-24 10:00:00', finished_at: '2026-10-24 10:00:05', http_status: 200,
      error_summary: null, details: JSON.stringify({ cancelled: 1, metrics: buildJobMetrics(1, 2) }),
    });
    expect(run.metrics).toEqual({ processed: 3, updated: 1, skipped: 2 });
  });
});
