/**
 * #1086 — `POST /api/internal/<path>`: the endpoint `.github/workflows/`'s
 * nightly runs call, relaying the request to the API's own route at
 * `CORDEL_FITNESS_API_URL`, so GitHub's runners no longer need a public API.
 *
 * `API_BASE_URL` in the GitHub `dev` and `pro` environments is the admin origin
 * plus this prefix, so the workflows keep calling `$API_BASE_URL/billing/run`
 * unchanged.
 *
 * Node runtime (not edge): edge fetch only allows ports 80/443, the API runs on
 * 3000 — and the upstream call is `node:http` rather than `fetch`, see
 * `lib/internalRunUpstream.ts`.
 *
 * Which paths may be relayed and what crosses the boundary is
 * `lib/internalRunRelay.ts`' — this file is the glue and decides nothing. It is
 * deliberately **not** `/api/proxy`: that route forwards a different header set
 * (`authorization`, `x-gym-id`, …) and none of `x-internal-secret`, so a run
 * sent through it would arrive unauthenticated, and widening that set would put
 * the internal runners behind a route the browser app also uses.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  RELAY_NOT_ALLOWED_STATUS,
  RELAY_TIMEOUT_STATUS,
  RELAY_UNCONFIGURED_STATUS,
  RELAY_UNREACHABLE_STATUS,
  internalRunApiPath,
  internalRunRelayTimeoutMs,
  internalRunTarget,
  relayedRequestHeaders,
} from '@/lib/internalRunRelay';
import { UpstreamTimeoutError, postToApi } from '@/lib/internalRunUpstream';

export const runtime = 'nodejs';

// The target comes from the environment per request: prerendering could only
// bake the build container's (empty) configuration into the deployed app.
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;

  // An explicit allowlist: this prefix is public, so a path the workflows do
  // not call is a 404 here rather than a request the API has to judge.
  const apiPath = internalRunApiPath(path);
  if (!apiPath) {
    return NextResponse.json({ error: 'Not found' }, { status: RELAY_NOT_ALLOWED_STATUS });
  }

  const target = internalRunTarget(process.env.CORDEL_FITNESS_API_URL, apiPath);
  if (!target) {
    console.error('Internal run relay: CORDEL_FITNESS_API_URL is not set');
    return NextResponse.json({ error: 'Relay not configured' }, { status: RELAY_UNCONFIGURED_STATUS });
  }

  // Bytes, never `req.text()`: #830's rule applies to a request body as much as
  // to a response, and the relay has no business re-serializing a payload it
  // does not read. These four runs send `{}` or nothing at all, so this is
  // about the relay staying a transport rather than about any one body.
  const body = Buffer.from(await req.arrayBuffer());

  let res;
  try {
    res = await postToApi(
      target,
      relayedRequestHeaders(req.headers),
      body,
      internalRunRelayTimeoutMs(process.env),
    );
  } catch (err) {
    // Never a 200: the workflows fail the job on a non-2xx and read the body
    // (#778), and a relay that answered 200 with no counters would be reported
    // as "an unreadable body" rather than as the API being out of reach.
    if (err instanceof UpstreamTimeoutError) {
      console.error('Internal run relay: API did not answer in time', err);
      return NextResponse.json({ error: 'Backend timed out' }, { status: RELAY_TIMEOUT_STATUS });
    }
    console.error('Internal run relay: API unreachable', err);
    return NextResponse.json({ error: 'Backend unreachable' }, { status: RELAY_UNREACHABLE_STATUS });
  }

  // The API's own status code and body, byte for byte — a 401 from a wrong
  // secret, a 429 from the internal-run limiter, a 200 carrying the run's
  // counters. The workflow parses those counters, so nothing here may reshape
  // them (#778).
  // `Uint8Array` rather than the `Buffer` itself only because that is what a
  // web `BodyInit` accepts; the bytes are the API's own either way.
  return new NextResponse(res.status === 204 ? null : new Uint8Array(res.body), {
    status: res.status,
    headers: { 'Content-Type': res.contentType ?? 'application/json' },
  });
}
