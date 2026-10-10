// #1086 — the decision half: which paths may be relayed, what crosses the
// boundary, and what the relay answers when it cannot reach the API.
//
// Pure, so none of this needs a server, a secret or a scheduled run. The
// properties CI enforces are pinned in
// `api/src/test/internal-run-relay.unit.test.ts` (CI runs `npm test` in `api/`
// only); these are the same rules observed directly.
import { describe, expect, it } from 'vitest';
import {
  INTERNAL_RUN_API_PATHS,
  INTERNAL_RUN_RELAY_PATH,
  INTERNAL_RUN_RELAY_TIMEOUT_MS_DEFAULT,
  RELAYED_REQUEST_HEADERS,
  internalRunApiPath,
  internalRunRelayTimeoutMs,
  internalRunTarget,
  relayedRequestHeaders,
} from '../lib/internalRunRelay';

describe('the allowlist', () => {
  it('is exactly the POSTs the workflows make', () => {
    expect([...INTERNAL_RUN_API_PATHS]).toEqual([
      '/billing/run',
      '/billing/cleanup',
      '/promotion-lifecycle/run',
      '/plan-allowance-renewals/run',
      '/recurring-bookings/run',
      // #1113: the 2-hour training reminder, the one run that is not nightly.
      '/booking-reminders/run',
    ]);
  });

  it('resolves each of them from its segments', () => {
    expect(internalRunApiPath(['billing', 'run'])).toBe('/billing/run');
    expect(internalRunApiPath(['billing', 'cleanup'])).toBe('/billing/cleanup');
    expect(internalRunApiPath(['promotion-lifecycle', 'run'])).toBe('/promotion-lifecycle/run');
    expect(internalRunApiPath(['recurring-bookings', 'run'])).toBe('/recurring-bookings/run');
    expect(internalRunApiPath(['booking-reminders', 'run'])).toBe('/booking-reminders/run');
  });

  it('refuses anything else, including a prefix of an allowed path', () => {
    for (const segments of [
      undefined,
      [],
      ['billing'],
      ['billing', 'run', 'extra'],
      ['gyms'],
      ['members', '7'],
      ['Billing', 'Run'],
      ['billing', ''],
    ]) {
      expect(internalRunApiPath(segments as string[] | undefined)).toBeNull();
    }
  });

  it('refuses a traversal, however it is spelled', () => {
    // Next decodes the segments, so `%2e%2e` arrives as `..` and a `/` inside
    // one segment arrives as a `/`.
    expect(internalRunApiPath(['billing', 'run', '..', '..', 'gyms'])).toBeNull();
    expect(internalRunApiPath(['billing', 'run/../../gyms'])).toBeNull();
    expect(internalRunApiPath(['..', 'gyms'])).toBeNull();
  });
});

describe('the relay prefix', () => {
  it('is the one the GitHub environments’ API_BASE_URL ends with', () => {
    // dev:  https://admin.vdicube.com/api/internal
    // pro:  https://admin.cordel.tech/api/internal
    expect(INTERNAL_RUN_RELAY_PATH).toBe('/api/internal');
  });
});

describe('the target', () => {
  it('is the configured API base plus the allowlisted path', () => {
    expect(internalRunTarget('http://api:3000', '/billing/run')).toBe('http://api:3000/billing/run');
  });

  it('tolerates a trailing slash on the base', () => {
    expect(internalRunTarget('http://api:3000/', '/billing/run')).toBe('http://api:3000/billing/run');
    expect(internalRunTarget('http://api:3000///', '/billing/run')).toBe('http://api:3000/billing/run');
  });

  it('is null when the base is missing or blank', () => {
    // Which is what makes the route answer 500 rather than requesting
    // `undefined/billing/run`.
    for (const base of [undefined, null, '', '   ']) {
      expect(internalRunTarget(base, '/billing/run')).toBeNull();
    }
  });
});

describe('what crosses the boundary', () => {
  it('forwards the secret, the content type and the client address, and nothing else', () => {
    expect([...RELAYED_REQUEST_HEADERS]).toEqual([
      'x-internal-secret',
      'content-type',
      'x-forwarded-for',
    ]);
  });

  it('drops a caller’s own credentials', () => {
    const headers = relayedRequestHeaders(
      new Headers({
        'X-Internal-Secret': 'shh',
        'Content-Type': 'application/json',
        'X-Forwarded-For': '203.0.113.7',
        authorization: 'Bearer sk_live_leaked',
        cookie: '__session=abc',
        'x-gym-id': '7',
        'x-impersonate-as': '12',
        host: 'admin.vdicube.com',
      }),
    );
    expect(headers).toEqual({
      'x-internal-secret': 'shh',
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.7',
    });
  });

  it('never invents a header the request did not carry', () => {
    // A missing secret must reach the API as a missing secret and be refused
    // there — the relay authenticates nothing.
    expect(relayedRequestHeaders(new Headers({ 'content-type': 'application/json' }))).toEqual({
      'content-type': 'application/json',
    });
  });
});

describe('the timeout', () => {
  it('defaults above the longest --max-time in the workflows (600 s)', () => {
    expect(INTERNAL_RUN_RELAY_TIMEOUT_MS_DEFAULT).toBeGreaterThan(600_000);
    expect(internalRunRelayTimeoutMs({})).toBe(INTERNAL_RUN_RELAY_TIMEOUT_MS_DEFAULT);
  });

  it('is configurable', () => {
    expect(internalRunRelayTimeoutMs({ INTERNAL_RUN_RELAY_TIMEOUT_MS: '900000' })).toBe(900_000);
  });

  it('falls back rather than honouring a value that would abort every run', () => {
    for (const raw of ['', '   ', '0', '-1', '1.5', 'soon']) {
      expect(internalRunRelayTimeoutMs({ INTERNAL_RUN_RELAY_TIMEOUT_MS: raw })).toBe(
        INTERNAL_RUN_RELAY_TIMEOUT_MS_DEFAULT,
      );
    }
  });
});
