// Integration tests for GET /health/runs (#782).
//
// The run logs are system-wide (no gym_id), and the test DB is shared: other
// test files — and other checkouts' runs — insert and delete run-log rows. So
// every case inserts its own rows with a far-future `finished_at`, which makes
// them the latest in the table whatever else is there, asserts relative to
// them, and deletes exactly those ids afterwards. Nothing here deletes a row
// it did not insert.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { request } from './helpers';

type Table = 'billing_run_log' | 'recurring_booking_run_log';

const inserted: Array<{ table: Table; id: number }> = [];

async function insertRun(
  table: Table,
  status: 'completed' | 'failed' | 'in_progress',
  startedAt: string,
  finishedAt: string | null,
): Promise<number> {
  // run_date far in the past keeps these rows out of claimRun()'s
  // "completed today" check, so a concurrent real run is never refused by them.
  const { insertId } = await db.query(
    `INSERT INTO ${table} (run_date, status, started_at, finished_at) VALUES ('2000-01-01', ?, ?, ?)`,
    [status, startedAt, finishedAt],
  );
  inserted.push({ table, id: insertId });
  return insertId;
}

afterEach(async () => {
  vi.useRealTimers();
  delete process.env.RUN_FRESHNESS_THRESHOLD_HOURS;
  for (const { table, id } of inserted.splice(0)) {
    await db.query(`DELETE FROM ${table} WHERE id = ?`, [id]);
  }
});

afterAll(async () => {
  await db.end();
});

describe('GET /health/runs', () => {
  it('answers 200 without any authentication, with exactly the documented shape', async () => {
    const res = await request.get('/health/runs');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['billing', 'recurring_bookings']);
    for (const key of ['billing', 'recurring_bookings']) {
      expect(Object.keys(res.body[key]).sort()).toEqual(['age_hours', 'last_completed_at', 'stale']);
      expect(typeof res.body[key].stale).toBe('boolean');
    }
  });

  it('reports the latest completed run of each log as fresh', async () => {
    await insertRun('billing_run_log', 'completed', '2099-06-01 02:00:00', '2099-06-01 02:05:00');
    await insertRun('recurring_booking_run_log', 'completed', '2099-06-01 03:00:00', '2099-06-01 03:01:00');

    const res = await request.get('/health/runs');
    expect(res.status).toBe(200);
    expect(res.body.billing).toMatchObject({
      last_completed_at: '2099-06-01T02:05:00.000Z',
      stale: false,
    });
    expect(res.body.recurring_bookings).toMatchObject({
      last_completed_at: '2099-06-01T03:01:00.000Z',
      stale: false,
    });
  });

  it('ignores failed and in_progress rows newer than the latest completed one', async () => {
    await insertRun('billing_run_log', 'completed', '2099-06-01 02:00:00', '2099-06-01 02:05:00');
    await insertRun('billing_run_log', 'failed', '2099-06-02 02:00:00', '2099-06-02 02:01:00');
    // An in_progress row carries no finished_at; started long ago so that
    // claimRun treats it as stale and a concurrent real run is never blocked.
    await insertRun('billing_run_log', 'in_progress', '2000-01-01 00:00:00', null);

    const res = await request.get('/health/runs');
    expect(res.status).toBe(200);
    expect(res.body.billing.last_completed_at).toBe('2099-06-01T02:05:00.000Z');
  });

  it('turns stale once the latest completed run is older than the threshold', async () => {
    await insertRun('billing_run_log', 'completed', '2099-06-01 02:00:00', '2099-06-01 02:00:00');
    await insertRun('recurring_booking_run_log', 'completed', '2099-06-01 02:00:00', '2099-06-01 02:00:00');

    // Only Date is faked, so the DB driver's timers keep running.
    vi.useFakeTimers({ toFake: ['Date'] });

    vi.setSystemTime(new Date('2099-06-02T04:00:00.000Z')); // 26 h — still fresh
    let res = await request.get('/health/runs');
    expect(res.status).toBe(200);
    expect(res.body.billing).toMatchObject({ age_hours: 26, stale: false });

    vi.setSystemTime(new Date('2099-06-02T05:00:00.000Z')); // 27 h — stale
    res = await request.get('/health/runs');
    expect(res.status).toBe(200);
    expect(res.body.billing).toMatchObject({
      last_completed_at: '2099-06-01T02:00:00.000Z',
      age_hours: 27,
      stale: true,
    });
    expect(res.body.recurring_bookings.stale).toBe(true);
  });

  it('honours RUN_FRESHNESS_THRESHOLD_HOURS', async () => {
    await insertRun('billing_run_log', 'completed', '2099-06-01 02:00:00', '2099-06-01 02:00:00');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2099-06-01T12:00:00.000Z')); // 10 h

    process.env.RUN_FRESHNESS_THRESHOLD_HOURS = '8';
    const res = await request.get('/health/runs');
    expect(res.body.billing).toMatchObject({ age_hours: 10, stale: true });
  });

  it('answers 503 when the run logs cannot be read', async () => {
    const spy = vi.spyOn(db, 'query').mockRejectedValueOnce(new Error('connection lost'));
    try {
      const res = await request.get('/health/runs');
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'Run logs unavailable' });
    } finally {
      spy.mockRestore();
    }
  });
});
