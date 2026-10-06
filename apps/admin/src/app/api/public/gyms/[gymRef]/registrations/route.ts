/**
 * #1175 — `POST /api/public/gyms/<gymRef>/registrations`: the endpoint a gym's
 * website (WordPress) posts its sign-ups to, relaying the request to the API's
 * own `/public/gyms/:gymRef/registrations` at `CORDEL_FITNESS_API_URL`, so the
 * websites no longer need a public API (#1087).
 *
 * Node runtime (not edge): edge fetch only allows ports 80/443, the API runs on 3000.
 *
 * Which path may be relayed and what crosses the boundary is
 * `lib/publicRegistrationRelay.ts`' — this file is the I/O half and decides
 * nothing. It is deliberately **not** `/api/proxy`: that route forwards a
 * signed-in user's headers and none of `x-api-key`.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  PUBLIC_REGISTRATION_RELAY_TIMEOUT_MS,
  RELAY_NOT_ALLOWED_STATUS,
  RELAY_TIMEOUT_STATUS,
  RELAY_UNCONFIGURED_STATUS,
  RELAY_UNREACHABLE_STATUS,
  publicRegistrationApiPath,
  publicRegistrationTarget,
  relayedRequestHeaders,
} from '@/lib/publicRegistrationRelay';

export const runtime = 'nodejs';

// The target comes from the environment per request: prerendering could only
// bake the build container's (empty) configuration into the deployed app.
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  // The raw, still-encoded pathname rather than the decoded `params`: the gym
  // reference is forwarded exactly as the website sent it.
  const apiPath = publicRegistrationApiPath(req.nextUrl.pathname);
  if (!apiPath) {
    return NextResponse.json({ error: 'Not found' }, { status: RELAY_NOT_ALLOWED_STATUS });
  }

  const url = publicRegistrationTarget(process.env.CORDEL_FITNESS_API_URL, apiPath);
  if (!url) {
    console.error('Public registration relay: CORDEL_FITNESS_API_URL is not set');
    return NextResponse.json({ error: 'Relay not configured' }, { status: RELAY_UNCONFIGURED_STATUS });
  }

  // Bytes, never `req.text()`: the relay has no business re-serializing a body
  // it does not read (#830's rule, applied to a request).
  const body = await req.arrayBuffer();

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: relayedRequestHeaders(req.headers),
      body,
      cache: 'no-store',
      signal: AbortSignal.timeout(PUBLIC_REGISTRATION_RELAY_TIMEOUT_MS),
    });
  } catch (err) {
    // Never a 2xx: a website told a sign-up was accepted when it never reached
    // the API would lose that person silently.
    if (err instanceof Error && err.name === 'TimeoutError') {
      console.error('Public registration relay: API did not answer in time', err);
      return NextResponse.json({ error: 'Backend timed out' }, { status: RELAY_TIMEOUT_STATUS });
    }
    console.error('Public registration relay: API unreachable', err);
    return NextResponse.json({ error: 'Backend unreachable' }, { status: RELAY_UNREACHABLE_STATUS });
  }

  // The API's own status and body — the 202, a 400 for a bad body, a 401 for a
  // wrong key, a 429 from either limiter, the health-check probe's 200.
  const headers: Record<string, string> = {
    'Content-Type': res.headers.get('Content-Type') ?? 'application/json',
  };
  // A 429 is only actionable with the API's own retry hint.
  const retryAfter = res.headers.get('Retry-After');
  if (retryAfter) headers['Retry-After'] = retryAfter;
  return new NextResponse(res.status === 204 ? null : await res.arrayBuffer(), {
    status: res.status,
    headers,
  });
}
