// #1166 — the I/O half: what the route actually sends and answers.
//
// `fetch` is stubbed, so this exercises the relay without an API. The
// properties CI enforces are pinned in `api/src/test/health-runs-relay.unit.test.ts`
// (CI runs `npm test` in `api/` only); these are the same rules observed at runtime.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../app/api/health/runs/route';

const FRESH = {
  billing: { last_completed_at: '2026-10-06T13:11:47.000Z', age_hours: 3.92, stale: false },
  recurring_bookings: { last_completed_at: null, age_hours: null, stale: true },
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.CORDEL_FITNESS_API_URL = 'http://api:3000/';
  fetchMock = vi.fn(async () => new Response(JSON.stringify(FRESH), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  }));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.CORDEL_FITNESS_API_URL;
});

describe('what the route sends upstream', () => {
  it('GETs the API’s own /health/runs, uncached, with a timeout and no headers', async () => {
    await GET();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://api:3000/health/runs');
    expect(init.method).toBe('GET');
    expect(init.cache).toBe('no-store');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toBeUndefined();
  });
});

describe('what the route answers', () => {
  it('relays the API’s status and body, stale or not', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual(FRESH);
  });

  it('relays the API’s 503 when the run logs cannot be read', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Run logs unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    }));
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Run logs unavailable' });
  });

  it('answers 502 when the API is unreachable', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const res = await GET();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Backend unreachable' });
  });

  it('answers 504 when the API does not answer in time', async () => {
    fetchMock.mockRejectedValueOnce(new DOMException('The operation timed out.', 'TimeoutError'));
    const res = await GET();
    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({ error: 'Backend timed out' });
  });

  it('answers 500 when the API base is not configured, without calling out', async () => {
    delete process.env.CORDEL_FITNESS_API_URL;
    const res = await GET();
    expect(res.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
