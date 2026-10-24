// #1996 stage 1 — the system jobs without a run log of their own write one
// `job_run_log` row per invocation, finalised on success.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, request } from './helpers';
import { safeErrorSummary } from '../infra/job-run-log';

const SECRET = 'test-job-run-log-secret';

async function latest(job: string) {
  const { rows } = await db.query(
    'SELECT status, finished_at, http_status, details FROM job_run_log WHERE job = ? ORDER BY id DESC LIMIT 1',
    [job],
  );
  return rows[0] as any;
}

describe('job_run_log (#1996)', () => {
  beforeAll(() => {
    process.env.BILLING_INTERNAL_SECRET = SECRET;
  });
  afterAll(async () => {
    await db.query('DELETE FROM job_run_log');
    await cleanupTestGyms();
    await db.end();
  });

  it('records a completed promotion lifecycle run with its counters', async () => {
    const res = await request.post('/promotion-lifecycle/run').set('X-Internal-Secret', SECRET);
    expect(res.status).toBe(200);
    const row = await latest('promotion_lifecycle');
    expect(row.status).toBe('completed');
    expect(row.finished_at).not.toBeNull();
    expect(row.http_status).toBe(200);
    const details = typeof row.details === 'string' ? JSON.parse(row.details) : row.details;
    expect(details).toEqual({ expired: res.body.expired });
  });

  it('records the billing cleanup run', async () => {
    const res = await request.post('/billing/cleanup').set('X-Internal-Secret', SECRET);
    expect(res.status).toBe(200);
    expect((await latest('billing_cleanup')).status).toBe('completed');
  });

  it('records nothing for an unauthenticated call', async () => {
    const before = await db.query('SELECT COUNT(*) AS n FROM job_run_log');
    const res = await request.post('/promotion-lifecycle/run').set('X-Internal-Secret', 'wrong');
    expect(res.status).toBe(401);
    const after = await db.query('SELECT COUNT(*) AS n FROM job_run_log');
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('keeps an error summary short, single-line and free of stack text', () => {
    const err = new Error(`boom\n  at x ${'y'.repeat(400)}`);
    const s = safeErrorSummary(err);
    expect(s.length).toBeLessThanOrEqual(255);
    expect(s).not.toContain('\n');
  });
});
