// #1175 — the I/O half: what the route actually sends and answers.
//
// `fetch` is stubbed, so this exercises the relay without an API, a gym or a
// key. The properties CI enforces are pinned in
// `api/src/test/public-registration-relay.unit.test.ts` (CI runs `npm test` in
// `api/` only); these are the same rules observed at runtime.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '../app/api/public/gyms/[gymRef]/registrations/route';

const REF = '48ded4d3-31a9-4334-86d1-c48bd6b48513-fit%20box';
const BODY = JSON.stringify({ name: 'Ana', email: 'ana@example.com' });

function registration(path = `/api/public/gyms/${REF}/registrations`, body: BodyInit = BODY): NextRequest {
  return new NextRequest(`https://admin.vdicube.com${path}`, {
    method: 'POST',
    headers: {
      'x-api-key': 'gdk_test_key',
      'content-type': 'application/json',
      'x-forwarded-for': '198.51.100.7',
      authorization: 'Bearer sk_live_leaked',
      cookie: '__session=abc',
    },
    body,
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.CORDEL_FITNESS_API_URL = 'http://api:3000';
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
    status: 202,
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
  it('POSTs to the API’s own route, the reference still encoded', async () => {
    await POST(registration());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://api:3000/public/gyms/${REF}/registrations`);
    expect(init.method).toBe('POST');
    expect(init.cache).toBe('no-store');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('forwards the key and the client chain, and drops the caller’s own credentials', async () => {
    await POST(registration());
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers).toEqual({
      'x-api-key': 'gdk_test_key',
      'content-type': 'application/json',
      'x-forwarded-for': '198.51.100.7',
    });
  });

  it('forwards the body byte for byte', async () => {
    const raw = new Uint8Array([0x7b, 0x22, 0x6e, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d]);
    await POST(registration(undefined, raw));
    const [, init] = fetchMock.mock.calls[0];
    expect(new Uint8Array(init.body as ArrayBuffer)).toEqual(raw);
  });
});

describe('what the route answers', () => {
  it('relays the API’s 202', async () => {
    const res = await POST(registration());
    expect(res.status).toBe(202);
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(await res.json()).toEqual({ ok: true });
  });

  it('relays a wrong key’s 401 rather than hiding it', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    }));
    const res = await POST(registration());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('relays a 429 with the API’s Retry-After', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Too many requests.' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '3600' },
    }));
    const res = await POST(registration());
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('3600');
  });

  it('answers 404 off the route, without calling out', async () => {
    const res = await POST(registration('/api/public/gyms/a%2Fb/registrations'));
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 502 when the API is unreachable', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const res = await POST(registration());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Backend unreachable' });
  });

  it('answers 504 when the API does not answer in time', async () => {
    fetchMock.mockRejectedValueOnce(new DOMException('The operation timed out.', 'TimeoutError'));
    expect((await POST(registration())).status).toBe(504);
  });

  it('answers 500 when the API base is not configured, without calling out', async () => {
    delete process.env.CORDEL_FITNESS_API_URL;
    const res = await POST(registration());
    expect(res.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
