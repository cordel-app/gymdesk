// #1083 — the payment webhook's 60/min budget is keyed on the client, not on
// the relay that forwarded the request.
//
// Monei posts to the isolated payment app and its nginx hands the request to
// the API's internal address, so every webhook arrives from one address. If
// that address is the key, one gym's payment traffic spends the budget for all
// of them and the API starts refusing payment confirmations — which Monei
// retries, but only so many times.
//
// No database is touched: every request here is refused by parseWebhook()'s
// signature check (or by the limiter before it), which is the route's first
// operation and makes no query.
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { request } from './helpers';

const LIMIT = 60;

/** One webhook POST, arriving through `relay` on behalf of `client`. */
function post(client: string, relay: string) {
  return request
    .post('/webhooks/payment')
    .set('X-Forwarded-For', `${client}, ${relay}`)
    .set('content-type', 'application/json')
    .send('{}');
}

async function spend(client: string, relay: string) {
  for (let i = 0; i < LIMIT; i++) {
    expect((await post(client, relay)).status).toBe(400);
  }
}

afterEach(() => {
  delete process.env.PAYMENT_WEBHOOK_RELAY_HOPS;
});

afterAll(async () => {
  await db.end();
});

describe('POST /webhooks/payment rate-limit key (#1083)', () => {
  it('still refuses one client after its own 60 in a minute', async () => {
    process.env.PAYMENT_WEBHOOK_RELAY_HOPS = '1';
    const relay = '192.0.2.10';
    await spend('198.51.100.10', relay);
    expect((await post('198.51.100.10', relay)).status).toBe(429);
  });

  it('gives two clients behind the same relay independent budgets', async () => {
    process.env.PAYMENT_WEBHOOK_RELAY_HOPS = '1';
    const relay = '192.0.2.11';
    await spend('198.51.100.11', relay);
    expect((await post('198.51.100.11', relay)).status).toBe(429);
    // The relay's budget is not what was spent — a second member paying through
    // the same relay is a second client.
    expect((await post('198.51.100.12', relay)).status).toBe(400);
  });

  it('shares one budget with no relay declared, which is why the hop is declared', async () => {
    // The pre-#1083 shape, kept as the default: req.ip is the relay, so this is
    // exactly the collapse the setting exists to undo.
    const relay = '192.0.2.12';
    await spend('198.51.100.13', relay);
    expect((await post('198.51.100.14', relay)).status).toBe(429);
  });
});
