// #1086 — the I/O half: what the route actually sends and answers.
//
// The transport (`lib/internalRunUpstream.ts`) is mocked, so this exercises the
// relay without an API, a secret or a scheduled run. The properties CI enforces
// are pinned in `api/src/test/internal-run-relay.unit.test.ts` (CI runs
// `npm test` in `api/` only); these are the same rules observed at runtime.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const postToApi = vi.fn();

vi.mock('../lib/internalRunUpstream', async () => {
  const actual = await vi.importActual<typeof import('../lib/internalRunUpstream')>(
    '../lib/internalRunUpstream',
  );
  return { ...actual, postToApi: (...args: unknown[]) => postToApi(...args) };
});

const { POST } = await import('../app/api/internal/[...path]/route');
const { UpstreamTimeoutError } = await import('../lib/internalRunUpstream');

const COUNTERS = { processed: 3, succeeded: 3, failed: 0, waived: 0 };

function runRequest(path: string[], body = '{}'): [NextRequest, { params: Promise<{ path: string[] }> }] {
  const req = new NextRequest(`https://admin.vdicube.com/api/internal/${path.join('/')}`, {
    method: 'POST',
    headers: {
      'x-internal-secret': 'shh',
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.7',
      authorization: 'Bearer sk_live_leaked',
      cookie: '__session=abc',
    },
    body,
  });
  return [req, { params: Promise.resolve({ path }) }];
}

beforeEach(() => {
  process.env.CORDEL_FITNESS_API_URL = 'http://api:3000';
  postToApi.mockResolvedValue({
    status: 200,
    body: Buffer.from(JSON.stringify(COUNTERS)),
    contentType: 'application/json',
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.CORDEL_FITNESS_API_URL;
  delete process.env.INTERNAL_RUN_RELAY_TIMEOUT_MS;
  postToApi.mockReset();
  vi.restoreAllMocks();
});

describe('what the route sends upstream', () => {
  it('POSTs to the API’s own path', async () => {
    await POST(...runRequest(['billing', 'run']));
    const [target] = postToApi.mock.calls[0];
    expect(target).toBe('http://api:3000/billing/run');
  });

  it('forwards the secret and the client address, and drops the caller’s own headers', async () => {
    await POST(...runRequest(['billing', 'cleanup']));
    const [, headers] = postToApi.mock.calls[0];
    expect(headers).toEqual({
      'x-internal-secret': 'shh',
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.7',
    });
  });

  it('relays the body as bytes', async () => {
    await POST(...runRequest(['recurring-bookings', 'run'], '{"limit":10}'));
    const [, , body] = postToApi.mock.calls[0];
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(body.toString('utf8')).toBe('{"limit":10}');
  });

  it('waits as long as the configured timeout', async () => {
    process.env.INTERNAL_RUN_RELAY_TIMEOUT_MS = '700000';
    await POST(...runRequest(['billing', 'run']));
    expect(postToApi.mock.calls[0][3]).toBe(700_000);
  });
});

describe('what the workflow is answered', () => {
  it('relays the API’s status and counters byte for byte', async () => {
    const res = await POST(...runRequest(['billing', 'run']));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(COUNTERS);
  });

  it('relays a 401 from a wrong secret rather than masking it', async () => {
    postToApi.mockResolvedValue({
      status: 401,
      body: Buffer.from(JSON.stringify({ error: 'Unauthorized' })),
      contentType: 'application/json',
    });
    const res = await POST(...runRequest(['billing', 'run']));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('relays the internal-run limiter’s 429', async () => {
    postToApi.mockResolvedValue({
      status: 429,
      body: Buffer.from('Too many requests'),
      contentType: 'text/plain',
    });
    const res = await POST(...runRequest(['billing', 'run']));
    expect(res.status).toBe(429);
  });

  it('answers 404 for a path outside the allowlist, without calling the API', async () => {
    const res = await POST(...runRequest(['gyms']));
    expect(res.status).toBe(404);
    expect(postToApi).not.toHaveBeenCalled();
  });

  it('answers 500 when the API URL is unset, without calling the API', async () => {
    delete process.env.CORDEL_FITNESS_API_URL;
    const res = await POST(...runRequest(['billing', 'run']));
    expect(res.status).toBe(500);
    expect(postToApi).not.toHaveBeenCalled();
  });

  it('answers 502 when the API is unreachable', async () => {
    postToApi.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await POST(...runRequest(['billing', 'run']));
    expect(res.status).toBe(502);
  });

  it('answers 504 when the API did not answer in time', async () => {
    // A different status from 502 on purpose: the run may well be executing.
    postToApi.mockRejectedValue(new UpstreamTimeoutError(660_000));
    const res = await POST(...runRequest(['recurring-bookings', 'run']));
    expect(res.status).toBe(504);
  });

  it('never answers 200 when it did not reach the API', async () => {
    // The workflows fail on a non-2xx and read the body (#778); a 200 with no
    // counters would be reported as an unreadable body instead.
    postToApi.mockRejectedValue(new Error('ENOTFOUND'));
    const res = await POST(...runRequest(['billing', 'run']));
    expect(res.status).not.toBe(200);
  });
});
