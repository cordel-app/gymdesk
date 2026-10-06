// #1086 — the internal run routes' shared budget is keyed on the client, not on
// the relay that forwarded the request.
//
// The nightly workflows post to the admin app's `/api/internal`, which hands
// the request to the API's internal address and forwards the `X-Forwarded-For`
// it was called with, so every run arrives from one address. If that address is
// the key, ten wrong-secret guesses from anywhere answer the billing run `429`
// for the rest of the window (#783: only a 401 spends the budget) — and a night
// nobody is charged on has to be caught up by hand.
//
// No database is touched: every request here is refused by
// `checkInternalSecret()`, or by the limiter before it, so no run executes.
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { INTERNAL_RUN_RATE_LIMIT_DEFAULT_MAX } from '../domain/internalRunRateLimit';
import { request } from './helpers';

const LIMIT = INTERNAL_RUN_RATE_LIMIT_DEFAULT_MAX;
const RELAY = '198.51.100.9';

/** One run POST with a wrong secret, arriving through `relay` for `client`. */
function post(client: string, relay: string) {
  return request
    .post('/billing/run')
    .set('X-Forwarded-For', `${client}, ${relay}`)
    .set('x-internal-secret', 'wrong')
    .send({});
}

async function spend(client: string, relay: string) {
  for (let i = 0; i < LIMIT; i++) {
    expect((await post(client, relay)).status).toBe(401);
  }
  expect((await post(client, relay)).status).toBe(429);
}

afterEach(() => {
  delete process.env.INTERNAL_RUN_RELAY_HOPS;
});

afterAll(async () => {
  await db.end();
});

describe('with the relay declared (INTERNAL_RUN_RELAY_HOPS=1)', () => {
  it('spends one client’s budget without touching another’s', async () => {
    process.env.INTERNAL_RUN_RELAY_HOPS = '1';
    await spend('203.0.113.20', RELAY);
    // The real workflow, arriving through the same relay, is unaffected.
    expect((await post('203.0.113.21', RELAY)).status).toBe(401);
  });
});

describe('with no relay configured', () => {
  it('keys on req.ip, exactly as before #1086', async () => {
    // `trust proxy` is 1, so req.ip is the rightmost X-Forwarded-For entry —
    // here the relay. Two different clients therefore share one bucket, which
    // is precisely why the hop above has to be declared in a deployment that
    // has one.
    const relay = '198.51.100.10';
    await spend('203.0.113.22', relay);
    expect((await post('203.0.113.23', relay)).status).toBe(429);
  });
});
