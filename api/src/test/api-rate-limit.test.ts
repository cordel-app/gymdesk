// Integration tests for the global limiter's key (#1395): the budget is per
// signed-in person, not per client address. Every request here is `GET /health`,
// which touches nothing, with an unverified bearer JWT whose subject is the only
// thing the limiter reads — so no row is written and nothing is authenticated.
// Each test takes its own address through X-Forwarded-For (trust proxy is 1,
// see app.ts) and its own subjects, so the buckets are independent of the other
// tests' and of every other file's (the store is in-process and files run in
// their own worker).
import { afterAll, describe, expect, it, vi } from 'vitest';

// The limit is read once, when app.ts is evaluated, so it is pinned before the
// helpers import the app: a handful of requests per budget rather than the
// default 500, which made the file both slow and flaky (supertest opens one
// ephemeral server per request, and ~1500 in a row occasionally reset).
const LIMIT = vi.hoisted(() => {
  process.env.API_RATE_LIMIT_MAX = '6';
  return 6;
});

import { db } from '../infra/db';
import { apiRateLimitMax } from '../domain/apiRateLimit';
import { request } from './helpers';

afterAll(async () => {
  await db.end();
});

function tokenFor(subject: string): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ sub: subject, exp: 0 })}.c2ln`;
}

function health(ip: string, subject?: string) {
  const req = request.get('/health').set('X-Forwarded-For', ip);
  return subject === undefined ? req : req.set('Authorization', `Bearer ${tokenFor(subject)}`);
}

async function spend(ip: string, subject?: string) {
  for (let i = 0; i < LIMIT; i++) {
    expect((await health(ip, subject)).status).toBe(200);
  }
  expect((await health(ip, subject)).status).toBe(429);
}

describe('global API rate limit key (#1395)', () => {
  it('runs against the pinned limit', () => {
    expect(apiRateLimitMax()).toBe(LIMIT);
  });

  it('two people behind one proxy address get two budgets', async () => {
    const proxy = '203.0.113.50';
    await spend(proxy, 'user_1395_a');
    expect((await health(proxy, 'user_1395_b')).status).toBe(200);
  });

  it('a person spending their budget does not spend the unauthenticated budget of that address, and vice versa', async () => {
    const proxy = '203.0.113.51';
    await spend(proxy, 'user_1395_c');
    expect((await health(proxy)).status).toBe(200);
    await spend('203.0.113.52');
    expect((await health('203.0.113.52', 'user_1395_d')).status).toBe(200);
  });

  it('one person is one budget from any address', async () => {
    await spend('203.0.113.53', 'user_1395_e');
    expect((await health('203.0.113.54', 'user_1395_e')).status).toBe(429);
  });

  it('a 429 carries the draft-7 RateLimit header and no legacy ones', async () => {
    const proxy = '203.0.113.55';
    await spend(proxy, 'user_1395_f');
    const res = await health(proxy, 'user_1395_f');
    expect(res.status).toBe(429);
    expect(res.headers['ratelimit']).toMatch(/limit=\d+/);
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
  });
});
