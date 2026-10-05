// #1072 (mobile app WP1) — the delivery loop of `infra/push.ts`: who gets a
// push, which token is deleted, and what a failure costs.
//
// Unit, not integration: the database is mocked and `fetch` is stubbed, so the
// whole of FCM's protocol (a locally signed service-account JWT exchanged for
// an access token, then one POST per token) is exercised with no network. The
// signing is real — the test generates an RSA key pair — because a key the
// crypto layer rejects is one of the two ways this module fails in production.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';

const query = vi.fn();
vi.mock('../infra/db', () => ({ db: { query: (...args: any[]) => query(...args) } }));

import { deliverPushNotifications, isPushConfigured, resetPushCredentialCache } from '../infra/push';

const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

function configure(apps: Record<string, string>) {
  process.env.FCM_SERVICE_ACCOUNTS = JSON.stringify(
    Object.fromEntries(Object.entries(apps).map(([appId, projectId]) => [appId, {
      project_id: projectId,
      client_email: `push@${projectId}.iam.gserviceaccount.com`,
      private_key: privateKey,
    }])),
  );
  resetPushCredentialCache();
}

const ALERT = {
  memberId: 7,
  type: 'booking_confirmed',
  entityType: 'session' as const,
  entityId: 42,
  payload: { title: 'Yoga' },
};

/**
 * The host a stubbed `fetch` call went to, compared as a **host** and never as a
 * substring of the URL: `url.includes('oauth2.googleapis.com')` would also be
 * true of `https://evil.example/?x=oauth2.googleapis.com`, which is CodeQL's
 * `js/incomplete-url-substring-sanitization` and a real bug in any code that
 * routes on it — a fixture is no reason to write the pattern.
 */
const isHost = (url: unknown, host: string): boolean => {
  try {
    return new URL(String(url)).host === host;
  } catch {
    return false;
  }
};

const GOOGLE_TOKEN_HOST = 'oauth2.googleapis.com';
const FCM_HOST = 'fcm.googleapis.com';

/** The token-exchange response, then whatever the send should answer. */
function stubFetch(send: { status: number; body?: unknown }) {
  const fetchMock = vi.fn(async (url: string) => {
    if (isHost(url, GOOGLE_TOKEN_HOST)) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'at-1', expires_in: 3600 }) } as any;
    }
    return {
      ok: send.status >= 200 && send.status < 300,
      status: send.status,
      json: async () => send.body ?? {},
    } as any;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Resolves after the module's own un-awaited promise chain has settled. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const ORIGINAL = process.env.FCM_SERVICE_ACCOUNTS;

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [], rowCount: 0, insertId: 0 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (ORIGINAL === undefined) delete process.env.FCM_SERVICE_ACCOUNTS;
  else process.env.FCM_SERVICE_ACCOUNTS = ORIGINAL;
  resetPushCredentialCache();
});

describe('a deployment with no FCM credentials', () => {
  it('is not configured, and does not even read the table', async () => {
    delete process.env.FCM_SERVICE_ACCOUNTS;
    resetPushCredentialCache();
    const fetchMock = stubFetch({ status: 200 });
    expect(isPushConfigured()).toBe(false);
    deliverPushNotifications('gym-1', [ALERT]);
    await settle();
    expect(query).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('delivery', () => {
  it('sends one message per token of the named member', async () => {
    configure({ 'com.cordel.fitness': 'cordel-dev' });
    query.mockResolvedValueOnce({
      rows: [
        { id: 1, member_id: 7, token: 'tok-a', app_id: 'com.cordel.fitness' },
        { id: 2, member_id: 7, token: 'tok-b', app_id: 'com.cordel.fitness' },
      ],
      rowCount: 2,
    });
    const fetchMock = stubFetch({ status: 200 });

    deliverPushNotifications('gym-1', [ALERT]);
    await settle();

    const sends = fetchMock.mock.calls.filter(([url]) => isHost(url, FCM_HOST));
    expect(sends).toHaveLength(2);
    const tokens = sends.map(([, init]: any) => JSON.parse(init.body).message.token);
    expect(tokens).toEqual(['tok-a', 'tok-b']);
    // The read is scoped by gym *and* member — a token is never looked up by
    // member alone.
    expect(query.mock.calls[0][0]).toContain('WHERE gym_id = ? AND member_id IN');
    expect(query.mock.calls[0][1]).toEqual(['gym-1', 7]);
    // Nothing is deleted on a successful send.
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('mints the access token once for several sends', async () => {
    configure({ 'com.cordel.fitness': 'cordel-dev' });
    query.mockResolvedValueOnce({
      rows: [
        { id: 1, member_id: 7, token: 'tok-a', app_id: 'com.cordel.fitness' },
        { id: 2, member_id: 8, token: 'tok-b', app_id: 'com.cordel.fitness' },
      ],
      rowCount: 2,
    });
    const fetchMock = stubFetch({ status: 200 });

    deliverPushNotifications('gym-1', [ALERT, { ...ALERT, memberId: 8 }]);
    await settle();

    const exchanges = fetchMock.mock.calls.filter(([url]) => isHost(url, GOOGLE_TOKEN_HOST));
    expect(exchanges).toHaveLength(1);
  });

  it('skips a token whose app this deployment holds no credentials for', async () => {
    // The stage-2 case: a per-gym app whose Firebase project is not configured
    // yet. It costs that app its push and must not look like an error.
    configure({ 'com.cordel.fitness': 'cordel-dev' });
    query.mockResolvedValueOnce({
      rows: [{ id: 3, member_id: 7, token: 'tok-c', app_id: 'com.gym.unknown' }],
      rowCount: 1,
    });
    const fetchMock = stubFetch({ status: 200 });

    deliverPushNotifications('gym-1', [ALERT]);
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the member has no device', async () => {
    configure({ 'com.cordel.fitness': 'cordel-dev' });
    const fetchMock = stubFetch({ status: 200 });
    deliverPushNotifications('gym-1', [ALERT]);
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('a failed send', () => {
  it('deletes a token FCM reports as UNREGISTERED', async () => {
    configure({ 'com.cordel.fitness': 'cordel-dev' });
    query.mockResolvedValueOnce({
      rows: [{ id: 9, member_id: 7, token: 'tok-dead', app_id: 'com.cordel.fitness' }],
      rowCount: 1,
    });
    stubFetch({
      status: 404,
      body: { error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } },
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    deliverPushNotifications('gym-1', [ALERT]);
    await settle();

    const deletes = query.mock.calls.filter(([sql]) => String(sql).includes('DELETE FROM member_device_tokens'));
    expect(deletes).toHaveLength(1);
    expect(deletes[0][1]).toEqual(['gym-1', 9]);
  });

  it('keeps a token on INVALID_ARGUMENT', async () => {
    configure({ 'com.cordel.fitness': 'cordel-dev' });
    query.mockResolvedValueOnce({
      rows: [{ id: 9, member_id: 7, token: 'tok-live', app_id: 'com.cordel.fitness' }],
      rowCount: 1,
    });
    stubFetch({ status: 400, body: { error: { status: 'INVALID_ARGUMENT' } } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    deliverPushNotifications('gym-1', [ALERT]);
    await settle();

    expect(query.mock.calls.some(([sql]) => String(sql).includes('DELETE'))).toBe(false);
  });

  it('never throws, whatever fails', async () => {
    configure({ 'com.cordel.fitness': 'cordel-dev' });
    query.mockRejectedValueOnce(new Error('db is down'));
    stubFetch({ status: 200 });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    // The caller is a request path that has already written the durable
    // `member_notifications` row: a push failure must cost the push alone.
    expect(() => deliverPushNotifications('gym-1', [ALERT])).not.toThrow();
    await settle();
    expect(error).toHaveBeenCalled();
  });

  it('survives an unreachable token endpoint', async () => {
    configure({ 'com.cordel.fitness': 'cordel-dev' });
    query.mockResolvedValueOnce({
      rows: [{ id: 1, member_id: 7, token: 'tok-a', app_id: 'com.cordel.fitness' }],
      rowCount: 1,
    });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ENOTFOUND'); }));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    deliverPushNotifications('gym-1', [ALERT]);
    await settle();

    expect(error).toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => String(sql).includes('DELETE'))).toBe(false);
  });
});
