// #3471 — Cordel → Jobs → Jobs tab: GET /platform/job-runs/jobs lists every registered
// job with its latest run across all stores; POST …/jobs/:job/run starts one through its
// own internal route, so the run lands in the same history a scheduled run writes.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, request } from './helpers';
import { JOB_RUN_JOBS } from '../domain/jobRuns';

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

const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER);
// Far in the future, so this row is the promotion lifecycle's latest whatever else ran.
const FUTURE = '2199-01-01 05:00:00';

describe('Cordel Jobs overview (#3471)', () => {
  const savedSecrets = {
    billing: process.env.BILLING_INTERNAL_SECRET,
    reminders: process.env.BOOKING_REMINDERS_INTERNAL_SECRET,
  };

  beforeAll(async () => {
    process.env.BILLING_INTERNAL_SECRET = savedSecrets.billing || 'test-billing-secret';
    await db.query(
      `INSERT INTO job_run_log (job, status, started_at, finished_at, http_status, details)
       VALUES ('promotion_lifecycle', 'completed', ?, ?, 200, JSON_OBJECT('expired', 2))`,
      [FUTURE, '2199-01-01 05:00:04'],
    );
  });
  beforeEach(() => { role.value = 'superadmin'; });
  afterAll(async () => {
    process.env.BILLING_INTERNAL_SECRET = savedSecrets.billing;
    process.env.BOOKING_REMINDERS_INTERNAL_SECRET = savedSecrets.reminders;
    await db.query(`DELETE FROM job_run_log WHERE started_at >= '2199-01-01'`);
    await cleanupTestGyms();
    await db.end();
  });

  it('401 without a token, 403 for a non-superadmin, on both routes', async () => {
    expect((await request.get('/platform/job-runs/jobs')).status).toBe(401);
    expect((await request.post('/platform/job-runs/jobs/billing_cleanup/run')).status).toBe(401);
    role.value = undefined;
    expect((await auth(request.get('/platform/job-runs/jobs'))).status).toBe(403);
    expect((await auth(request.post('/platform/job-runs/jobs/billing_cleanup/run'))).status).toBe(403);
  });

  it('lists every registered job, with its latest run and whether it can be started', async () => {
    const res = await auth(request.get('/platform/job-runs/jobs'));
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: any) => i.job)).toEqual([...JOB_RUN_JOBS]);
    const promo = res.body.items.find((i: any) => i.job === 'promotion_lifecycle');
    expect(promo.latest_run).toMatchObject({
      job: 'promotion_lifecycle', status: 'completed', started_at: '2199-01-01T05:00:00.000Z',
      http_status: 200, details: { expired: 2 },
    });
    expect(promo.manual).toBe(true);
    // The nightly billing run charges stored cards: never a button.
    expect(res.body.items.find((i: any) => i.job === 'billing_run').manual).toBe(false);
  });

  it('starts a job through its own route and answers the run it recorded', async () => {
    const before = new Date(Date.now() - 2000).toISOString();
    const res = await auth(request.post('/platform/job-runs/jobs/assignment_lifecycle/run'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ job: 'assignment_lifecycle', http_status: 200 });
    expect(res.body.latest_run.job).toBe('assignment_lifecycle');
    expect(res.body.latest_run.started_at >= before).toBe(true);
    expect(res.body.latest_run.status).toBe('completed');
    // The secret never reaches the client.
    expect(JSON.stringify(res.body)).not.toContain(process.env.BILLING_INTERNAL_SECRET!);
  });

  it('refuses the billing run, an unknown job and a job whose secret is not configured', async () => {
    const billing = await auth(request.post('/platform/job-runs/jobs/billing_run/run'));
    expect(billing.status).toBe(409);
    expect(billing.body.error).toBe('manual_run_not_supported');

    expect((await auth(request.post('/platform/job-runs/jobs/nope/run'))).status).toBe(404);

    delete process.env.BOOKING_REMINDERS_INTERNAL_SECRET;
    const reminders = await auth(request.post('/platform/job-runs/jobs/booking_reminders/run'));
    expect(reminders.status).toBe(503);
    expect(reminders.body.error).toBe('not_configured');
    const list = await auth(request.get('/platform/job-runs/jobs'));
    expect(list.body.items.find((i: any) => i.job === 'booking_reminders').manual).toBe(false);
  });
});
