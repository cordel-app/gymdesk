/**
 * #1085 — Clerk posts its webhook to the **admin app**, which relays it to the
 * API's own `/webhooks/clerk`, so Clerk no longer needs a public API.
 *
 * This module is the **decision** half: what the relay forwards, where it
 * forwards it, and what it answers when it cannot. It is pure — no `fetch`, no
 * `next/server`, no environment read of its own — so every rule below is
 * assertable without a server, a Clerk account or a signed payload.
 * `app/api/webhooks/clerk/route.ts` is the I/O half and decides nothing, the
 * same two-module split #1073 and #1074 used for the same reason.
 *
 * The relay **verifies nothing**. `CLERK_WEBHOOK_SIGNING_SECRET` stays in the
 * API, whose route parses its own raw body and makes `verifyWebhook()` its
 * first operation, so a tampered body is still a 400 — from the API, relayed as
 * such. That is also why the forwarded set below is exactly the three Svix
 * headers plus the content type: the signature is computed over
 * `svix-id.svix-timestamp.<body bytes>`, so dropping one of them, or letting
 * anything rewrite the body, breaks a signature this app cannot recompute.
 */

/** The API path this relays to. One spelling, used to build the target URL. */
export const CLERK_WEBHOOK_API_PATH = '/webhooks/clerk';

/** The admin-app path Clerk is pointed at (`https://admin.…` + this). */
export const CLERK_WEBHOOK_RELAY_PATH = '/api/webhooks/clerk';

/**
 * The three headers Svix signs with. Each is part of the signature's own input,
 * so all three travel or none of them is worth sending.
 */
export const SVIX_SIGNATURE_HEADERS = ['svix-id', 'svix-timestamp', 'svix-signature'] as const;

/**
 * Everything the relay forwards, and nothing else — deliberately **not**
 * `/api/proxy`'s set, which carries `authorization`, `x-gym-id`, `x-center-id`,
 * `x-impersonate-as` and `x-locale` and would hand a caller's own headers to a
 * route that authenticates by signature alone. No cookie, no authorization and
 * no `host` crosses this boundary.
 */
export const RELAYED_REQUEST_HEADERS = [...SVIX_SIGNATURE_HEADERS, 'content-type'] as const;

/** A header name/value source, i.e. what `Headers.entries()` gives. */
export type HeaderEntries = Iterable<readonly [string, string]>;

/**
 * The headers to send upstream, lower-cased and filtered to
 * `RELAYED_REQUEST_HEADERS`. A header the request does not carry is simply
 * absent: a missing `svix-signature` must reach the API as a missing signature
 * and be refused there, never be invented here.
 */
export function relayedRequestHeaders(source: HeaderEntries): Record<string, string> {
  const allowed = new Set<string>(RELAYED_REQUEST_HEADERS);
  const headers: Record<string, string> = {};
  for (const [name, value] of source) {
    const key = name.toLowerCase();
    if (allowed.has(key)) headers[key] = value;
  }
  return headers;
}

/**
 * The URL to relay to, or `null` when the API base is not configured. `null` is
 * what makes the route answer a 500 rather than fetching `undefined/webhooks/clerk`
 * — a misconfigured relay has to be a failure Clerk retries, not a 200 that
 * swallows a `user.deleted`.
 */
export function clerkWebhookTarget(apiBaseUrl: string | undefined | null): string | null {
  const base = (apiBaseUrl ?? '').trim().replace(/\/+$/, '');
  return base === '' ? null : `${base}${CLERK_WEBHOOK_API_PATH}`;
}

/** What the relay answers when it never reached the API. */
export const RELAY_UNREACHABLE_STATUS = 502;

/** What the relay answers when `CORDEL_FITNESS_API_URL` is not configured. */
export const RELAY_UNCONFIGURED_STATUS = 500;
