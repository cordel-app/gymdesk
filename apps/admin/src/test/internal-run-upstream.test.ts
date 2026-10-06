// #1086 — the transport half, against a real local HTTP server.
//
// This is the half that cannot be `fetch`: undici abandons a response whose
// headers take more than 300 s and `POST /recurring-bookings/run` is allowed
// 600 s, so the request is made with `node:http` where the only timeout that
// applies is the one passed in. That is worth exercising rather than asserting
// about.
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { UpstreamTimeoutError, postToApi } from '../lib/internalRunUpstream';

let server: Server | undefined;

interface Received {
  method?: string;
  url?: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

/** Start a server that answers `respond` and record what it was called with. */
async function serve(
  respond: (req: IncomingMessage, received: Received) => { status: number; body: string; contentType?: string } | 'hang',
): Promise<{ origin: string; received: Received }> {
  const received: Received = { headers: {}, body: Buffer.alloc(0) };
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.method = req.method;
      received.url = req.url;
      received.headers = req.headers;
      received.body = Buffer.concat(chunks);
      const answer = respond(req, received);
      if (answer === 'hang') return; // never answers: the timeout's case
      res.writeHead(answer.status, { 'content-type': answer.contentType ?? 'application/json' });
      res.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { origin: `http://127.0.0.1:${port}`, received };
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

describe('postToApi', () => {
  it('POSTs the body and headers it is given', async () => {
    const { origin, received } = await serve(() => ({
      status: 200,
      body: JSON.stringify({ processed: 2 }),
    }));

    const res = await postToApi(
      `${origin}/billing/run`,
      { 'x-internal-secret': 'shh', 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
      Buffer.from('{}'),
      5_000,
    );

    expect(received.method).toBe('POST');
    expect(received.url).toBe('/billing/run');
    expect(received.headers['x-internal-secret']).toBe('shh');
    expect(received.headers['x-forwarded-for']).toBe('203.0.113.7');
    expect(received.headers['content-length']).toBe('2');
    expect(received.body.toString('utf8')).toBe('{}');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body.toString('utf8'))).toEqual({ processed: 2 });
    expect(res.contentType).toContain('application/json');
  });

  it('relays a non-2xx status rather than throwing on it', async () => {
    // A 401 from a wrong secret and a 429 from the internal-run limiter are
    // answers the workflow has to see, not transport failures.
    const { origin } = await serve(() => ({ status: 401, body: '{"error":"Unauthorized"}' }));
    const res = await postToApi(`${origin}/billing/run`, {}, Buffer.from('{}'), 5_000);
    expect(res.status).toBe(401);
  });

  it('keeps the body byte-exact, whatever is in it', async () => {
    // Not valid UTF-8 (0xff), so a `req.text()` anywhere in the chain would
    // replace it with U+FFFD and nothing would error — #830's defect.
    const { origin, received } = await serve(() => ({ status: 200, body: '{}' }));
    const bytes = Buffer.from([0x7b, 0x22, 0xc3, 0xa9, 0xff, 0x22, 0x7d]);
    const res = await postToApi(`${origin}/billing/cleanup`, {}, bytes, 5_000);
    expect(res.status).toBe(200);
    expect([...received.body]).toEqual([...bytes]);
  });

  it('rejects with UpstreamTimeoutError when the API never answers', async () => {
    const { origin } = await serve(() => 'hang');
    await expect(postToApi(`${origin}/recurring-bookings/run`, {}, Buffer.from('{}'), 150)).rejects.toBeInstanceOf(
      UpstreamTimeoutError,
    );
  });

  it('rejects when the API is not listening at all', async () => {
    // Port 1 on loopback: nothing serves it, so the connection is refused.
    await expect(postToApi('http://127.0.0.1:1/billing/run', {}, Buffer.from('{}'), 1_000)).rejects.toBeTruthy();
  });
});
