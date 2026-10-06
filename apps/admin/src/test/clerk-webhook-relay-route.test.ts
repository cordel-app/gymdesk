// #1085 — the I/O half: what the route actually sends and answers.
//
// `fetch` is stubbed, so this exercises the relay without an API, a Clerk
// account or a signed payload. The properties CI enforces are pinned in
// `api/src/test/clerk-webhook-relay.unit.test.ts` (CI runs `npm test` in
// `api/` only); these are the same rules observed at runtime.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '../app/api/webhooks/clerk/route';

const BODY = JSON.stringify({ type: 'user.deleted', data: { id: 'user_2abc' } });

function webhookRequest(body: string | Uint8Array = BODY): NextRequest {
  return new NextRequest('https://admin.vdicube.com/api/webhooks/clerk', {
    method: 'POST',
    headers: {
      'svix-id': 'msg_2abc',
      'svix-timestamp': '1760000000',
      'svix-signature': 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
      'content-type': 'application/json',
      authorization: 'Bearer sk_live_leaked',
      cookie: '__session=abc',
      'x-gym-id': '7',
    },
    body,
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.CORDEL_FITNESS_API_URL = 'http://api:3000';
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
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
  it('POSTs to the API’s own /webhooks/clerk', async () => {
    await POST(webhookRequest());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://api:3000/webhooks/clerk');
    expect(init.method).toBe('POST');
    expect(init.cache).toBe('no-store');
  });

  it('forwards the Svix headers and drops the caller’s own', async () => {
    await POST(webhookRequest());
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers).toEqual({
      'svix-id': 'msg_2abc',
      'svix-timestamp': '1760000000',
      'svix-signature': 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
      'content-type': 'application/json',
    });
  });

  it('forwards the body byte for byte', async () => {
    // Bytes that are not valid UTF-8: a text round trip would replace each
    // with U+FFFD, and the API's HMAC is over exactly what Clerk sent.
    const raw = new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d]);
    await POST(webhookRequest(raw));
    const [, init] = fetchMock.mock.calls[0];
    expect(new Uint8Array(init.body as ArrayBuffer)).toEqual(raw);
  });
});

describe('what the route answers', () => {
  it('relays the API’s status and body on success', async () => {
    const res = await POST(webhookRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
  });

  it('relays a bad-signature 400 rather than hiding it', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Invalid signature' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    }));
    const res = await POST(webhookRequest());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid signature' });
  });

  it('relays a 500 so Clerk retries', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 500 }));
    expect((await POST(webhookRequest())).status).toBe(500);
  });

  it('answers 502 when the API is unreachable', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const res = await POST(webhookRequest());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Backend unreachable' });
  });

  it('answers 500 when the API base is not configured, without calling out', async () => {
    delete process.env.CORDEL_FITNESS_API_URL;
    const res = await POST(webhookRequest());
    expect(res.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
