// #1175 — the website-registration route's per-IP budget is keyed on the
// website, not on the relay that forwarded the request.
//
// Gym websites post to the admin app's registration relay, which hands the
// request to the API's internal address and forwards the `X-Forwarded-For` it
// was called with, so every sign-up arrives from one address. If that address
// is the key, every gym's website shares one hourly budget
// (`PUBLIC_REGISTRATION_IP_LIMIT_PER_HOUR`), and one busy or abused site answers
// every other gym's sign-ups `429`.
//
// The limiter runs before any gym lookup; the requests here name a gym that
// does not exist, so nothing is registered and only the status matters.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { request } from './helpers';

const LIMIT = 2;
const PATH = '/public/gyms/00000000-0000-4000-8000-000000000000-nowhere/registrations';

/** One sign-up from `client`'s website, arriving through `relay`. */
function post(client: string, relay: string) {
  return request
    .post(PATH)
    .set('X-Forwarded-For', `${client}, ${relay}`)
    .set('x-api-key', 'gdk_wrong')
    .send({ name: 'Web Person', email: 'web-person@relay.test' });
}

async function spend(client: string, relay: string) {
  for (let i = 0; i < LIMIT; i++) {
    expect((await post(client, relay)).status).not.toBe(429);
  }
  expect((await post(client, relay)).status).toBe(429);
}

let savedLimit: string | undefined;

beforeAll(() => {
  savedLimit = process.env.PUBLIC_REGISTRATION_IP_LIMIT_PER_HOUR;
  process.env.PUBLIC_REGISTRATION_IP_LIMIT_PER_HOUR = String(LIMIT);
});

afterEach(() => {
  delete process.env.PUBLIC_REGISTRATION_RELAY_HOPS;
});

afterAll(async () => {
  if (savedLimit === undefined) delete process.env.PUBLIC_REGISTRATION_IP_LIMIT_PER_HOUR;
  else process.env.PUBLIC_REGISTRATION_IP_LIMIT_PER_HOUR = savedLimit;
  await db.end();
});

describe('with the relay declared (PUBLIC_REGISTRATION_RELAY_HOPS=1)', () => {
  it('spends one website’s budget without touching another’s', async () => {
    process.env.PUBLIC_REGISTRATION_RELAY_HOPS = '1';
    const relay = '198.51.100.30';
    await spend('203.0.113.40', relay);
    // Another gym's website, through the same relay, is unaffected.
    expect((await post('203.0.113.41', relay)).status).not.toBe(429);
  });
});

describe('with no relay configured', () => {
  it('keys on req.ip, exactly as before #1175', async () => {
    // `trust proxy` is 1, so req.ip is the rightmost X-Forwarded-For entry —
    // here the relay — and two websites share one bucket, which is why the hop
    // above has to be declared in a deployment that has one.
    const relay = '198.51.100.31';
    await spend('203.0.113.42', relay);
    expect((await post('203.0.113.43', relay)).status).toBe(429);
  });
});
