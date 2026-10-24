// #1996 stage 2 — GET /platform/job-runs: one normalized, filterable list over
// billing_run_log, recurring_booking_run_log and job_run_log. Superadmin only.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, request } from './helpers';

const role = vi.hoisted(() => ({ value: 'superadmin' as string | undefined }));

vi.mock('@clerk/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/backend')>();
  return {
    ...actual,
    verifyToken: vi.fn().mockResolvedValue({ sub: 'test-user-id' }),
    createClerkClient: vi.fn(() => ({
      users: {
        getUser: vi.fn().mockImplementation(async () => ({
          publicMetadata: role.value ? { platform_role: role.value } : {},
          fullName: 'Tester', firstName: 'Test', lastName: 'Er',
        })),
        getUserList: vi.fn().mockResolvedValue({ data: [], totalCount: 0 }),
      },
      invitations: { createInvitation: vi.fn(), revokeInvitation: vi.fn() },
      emailAddresses: { getEmailAddress: vi.fn() },
    })),
  };
});

const get = (qs = '') => request.get(`/platform/job-runs${qs}`).set('Authorization', TEST_AUTH_HEADER);

// Far-future dates keep these rows apart from anything else in the shared test database.
const D1 = '2099-03-01';
const D2 = '2099-03-02';
const RANGE = `from=${D1}&to=${D2}`;

describe('GET /platform/job-runs (#1996)', () => {
  beforeAll(async () => {
    await db.query(
      `INSERT INTO billing_run_log (run_date, status, started_at, finished_at, processed, succeeded, failed, waived)
       VALUES (?, 'completed', ?, ?, 5, 4, 1, 0)`,
      [D1, `${D1} 06:00:00`, `${D1} 06:00:30`],
    );
    await db.query(
      `INSERT INTO recurring_booking_run_log (run_date, status, started_at, finished_at, processed, created, skipped, failed, notified)
       VALUES (?, 'failed', ?, ?, 3, 2, 1, 0, 2)`,
      [D2, `${D2} 03:00:00`, `${D2} 03:00:10`],
    );
    await db.query(
      `INSERT INTO job_run_log (job, status, started_at, finished_at, http_status, details, error_summary)
       VALUES ('booking_reminders', 'failed', ?, ?, 500, NULL, 'boom'),
              ('billing_cleanup', 'in_progress', ?, NULL, NULL, NULL, NULL)`,
      [`${D2} 10:00:00`, `${D2} 10:00:02`, `${D2} 11:00:00`],
    );
  });
  beforeEach(() => { role.value = 'superadmin'; });
  afterAll(async () => {
    await db.query(`DELETE FROM billing_run_log WHERE run_date = ?`, [D1]);
    await db.query(`DELETE FROM recurring_booking_run_log WHERE run_date = ?`, [D2]);
    await db.query(`DELETE FROM job_run_log WHERE started_at >= ?`, [`${D1} 00:00:00`]);
    await cleanupTestGyms();
    await db.end();
  });

  it('401 without a token, 403 for a non-superadmin', async () => {
    expect((await request.get('/platform/job-runs')).status).toBe(401);
    role.value = undefined;
    expect((await get()).status).toBe(403);
  });

  it('lists every source newest first with the normalized shape', async () => {
    const res = await get(`?${RANGE}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
    expect(res.body.items.map((r: any) => r.job)).toEqual([
      'billing_cleanup', 'booking_reminders', 'recurring_bookings', 'billing_run',
    ]);
    const billing = res.body.items[3];
    expect(billing).toMatchObject({
      status: 'completed',
      started_at: `${D1}T06:00:00.000Z`,
      finished_at: `${D1}T06:00:30.000Z`,
      duration_seconds: 30,
      http_status: null,
      error_summary: null,
    });
    expect(billing.details).toMatchObject({ processed: 5, succeeded: 4, failed: 1, waived: 0 });
    const inProgress = res.body.items[0];
    expect(inProgress).toMatchObject({ status: 'in_progress', finished_at: null, duration_seconds: null });
    expect(res.body.items[1]).toMatchObject({ http_status: 500, error_summary: 'boom', details: {} });
  });

  it('filters by job, status and date range', async () => {
    const byJob = await get(`?${RANGE}&job=billing_run`);
    expect(byJob.body.items.map((r: any) => r.job)).toEqual(['billing_run']);
    const byStatus = await get(`?${RANGE}&status=failed`);
    expect(byStatus.body.items.map((r: any) => r.job).sort()).toEqual(['booking_reminders', 'recurring_bookings']);
    const oneDay = await get(`?from=${D1}&to=${D1}`);
    expect(oneDay.body.total).toBe(1);
  });

  it('paginates and reports the total', async () => {
    const page = await get(`?${RANGE}&limit=2&offset=2`);
    expect(page.body.total).toBe(4);
    expect(page.body.items.map((r: any) => r.job)).toEqual(['recurring_bookings', 'billing_run']);
    expect(page.body).toMatchObject({ limit: 2, offset: 2 });
  });

  it('rejects an invalid filter instead of widening the list', async () => {
    for (const qs of ['job=nope', 'status=nope', 'from=2099-13-40', 'to=yesterday', 'limit=0', 'limit=1000', 'offset=-1', `from=${D2}&to=${D1}`]) {
      expect((await get(`?${qs}`)).status, qs).toBe(400);
    }
  });
});
