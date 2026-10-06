/**
 * #1085 — `POST /api/webhooks/clerk`: the endpoint Clerk's dashboard points at,
 * relaying the request to the API's own `/webhooks/clerk` at `CORDEL_FITNESS_API_URL`.
 *
 * Node runtime (not edge): edge fetch only allows ports 80/443, the API runs on 3000.
 *
 * What is relayed and where is `lib/clerkWebhookRelay.ts`' — this file is the
 * I/O half and decides nothing. It is deliberately **not** `/api/proxy`: that
 * route forwards a different header set (`authorization`, `x-gym-id`, …) and
 * none of the Svix ones, so a webhook sent through it would reach the API with
 * no signature at all.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  RELAY_UNCONFIGURED_STATUS,
  RELAY_UNREACHABLE_STATUS,
  clerkWebhookTarget,
  relayedRequestHeaders,
} from '@/lib/clerkWebhookRelay';

// The target comes from the environment per request: prerendering could only
// bake the build container's (empty) configuration into the deployed app.
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const url = clerkWebhookTarget(process.env.CORDEL_FITNESS_API_URL);
  if (!url) {
    console.error('Clerk webhook relay: CORDEL_FITNESS_API_URL is not set');
    return NextResponse.json({ error: 'Relay not configured' }, { status: RELAY_UNCONFIGURED_STATUS });
  }

  // The exact bytes Clerk signed. Read as an ArrayBuffer and passed on
  // unchanged: `req.text()` + re-serialization would break the HMAC the API
  // verifies over `svix-id.svix-timestamp.<body>`, and #830's reason applies to
  // a request body as much as to a response — a UTF-8 round trip is not
  // byte-exact for every byte a sender may put on the wire.
  const body = await req.arrayBuffer();

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: relayedRequestHeaders(req.headers),
      body,
      cache: 'no-store',
    });
  } catch (err) {
    // 502, never a 200: Clerk retries exactly what we report as failed, and a
    // missed `user.deleted` leaves an orphaned Clerk account linked to rows
    // that should have been cleaned up (#709).
    console.error('Clerk webhook relay: API unreachable', err);
    return NextResponse.json({ error: 'Backend unreachable' }, { status: RELAY_UNREACHABLE_STATUS });
  }

  // The API's own status code is what Clerk gets — a bad signature stays a 400,
  // an API error stays an error and is retried. Bytes rather than `res.text()`,
  // for #830's reason.
  const resBody = res.status === 204 ? null : await res.arrayBuffer();
  return new NextResponse(resBody, {
    status: res.status,
    headers: { 'Content-Type': res.headers.get('Content-Type') ?? 'application/json' },
  });
}
