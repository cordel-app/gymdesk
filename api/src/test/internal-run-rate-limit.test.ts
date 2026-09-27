// Integration tests for the per-route limiter on the internal run endpoints
// (#783): POST /billing/run, POST /billing/cleanup, POST /recurring-bookings/run.
//
// Every request here is refused by checkInternalSecret() — or by the limiter
// before it — so no run executes and no row is touched. Each test takes its own
// client address through X-Forwarded-For (trust proxy is 1, see app.ts) so the
// buckets are independent. That a caller holding the secret never spends the
// budget is pinned by the unit test of spendsInternalRunBudget() and, end to
// end, by billing-run.test.ts: it calls /billing/run with the right secret far
// more often than the limit allows from one address, and would 429 otherwise.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { INTERNAL_RUN_RATE_LIMIT_DEFAULT_MAX } from '../domain/internalRunRateLimit';
import { cleanupTestGyms, request } from './helpers';

const BILLING_SECRET = 'test-billing-secret';
const RECURRING_SECRET = 'test-recurring-secret';
const LIMIT = INTERNAL_RUN_RATE_LIMIT_DEFAULT_MAX;

beforeAll(() => {
  process.env.BILLING_INTERNAL_SECRET = BILLING_SECRET;
  process.env.RECURRING_BOOKINGS_INTERNAL_SECRET = RECURRING_SECRET;
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

function post(path: string, ip: string, secret?: string) {
  const req = request.post(path).set('X-Forwarded-For', ip);
  return (secret === undefined ? req : req.set('x-internal-secret', secret)).send({});
}

describe('internal run rate limit (#783)', () => {
  it(`answers 429 to the unauthenticated POST /billing/run after ${LIMIT} failed ones`, async () => {
    const ip = '203.0.113.10';
    for (let i = 0; i < LIMIT; i++) {
      expect((await post('/billing/run', ip)).status).toBe(401);
    }
    expect((await post('/billing/run', ip)).status).toBe(429);
  });

  it('keeps refusing that address even with the right secret until the window ends', async () => {
    const ip = '203.0.113.11';
    for (let i = 0; i < LIMIT; i++) {
      expect((await post('/billing/run', ip, 'wrong')).status).toBe(401);
    }
    const res = await post('/billing/run', ip, BILLING_SECRET);
    expect(res.status).toBe(429);
    // Refused by the limiter, not by the run guard: no run summary in the body.
    expect(res.body).not.toHaveProperty('processed');
  });

  it('keys the budget by client address', async () => {
    const spent = '203.0.113.12';
    for (let i = 0; i < LIMIT; i++) await post('/billing/run', spent);
    expect((await post('/billing/run', spent)).status).toBe(429);
    expect((await post('/billing/run', '203.0.113.13')).status).toBe(401);
  });

  it('shares one budget across /billing/cleanup and /recurring-bookings/run', async () => {
    const ip = '203.0.113.14';
    for (let i = 0; i < LIMIT; i++) {
      const path = i % 2 === 0 ? '/billing/cleanup' : '/recurring-bookings/run';
      expect((await post(path, ip, 'wrong')).status).toBe(401);
    }
    expect((await post('/recurring-bookings/run', ip, RECURRING_SECRET)).status).toBe(429);
    expect((await post('/billing/cleanup', ip, BILLING_SECRET)).status).toBe(429);
  });
});
