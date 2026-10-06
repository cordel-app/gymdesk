/**
 * #1175 — gym websites (WordPress) post their sign-ups to the **admin app**,
 * which relays them to the API's own `/public/gyms/:gymRef/registrations`
 * (#599, #645), so the websites no longer need a public API (#1087).
 *
 * This module is the **decision** half: which paths may be relayed, where they
 * are relayed to, what crosses the boundary and what the relay answers when it
 * cannot. It is pure — no `fetch`, no `next/server`, no environment read of its
 * own — so every rule below is assertable without a server, a gym or a key.
 * `app/api/public/gyms/[gymRef]/registrations/route.ts` is the I/O half and
 * decides nothing, the split #1085, #1086 and #1166 use for the same reason.
 *
 * The relay **authenticates nothing**. The gym's website key travels in
 * `x-api-key` and is compared by the API (`verifyWebsiteApiKey()`), so a wrong
 * key is still a `401` **from the API**, relayed as such, and the API's own
 * per-gym and per-IP limits still apply. The relay is a transport, never a
 * second trust boundary.
 */

/** The admin-app path prefix the websites post to (`https://admin.…` + this). */
export const PUBLIC_REGISTRATION_RELAY_PREFIX = '/api/public/gyms/';

/**
 * The one path shape this relay serves:
 * `/api/public/gyms/<gymRef>/registrations`, where `<gymRef>` is a **single**
 * raw path segment (#645's `{gymId}-{encoded gym name}`, or a pre-#645 slug).
 *
 * Matched on the raw, still-encoded pathname, so neither a second segment, a
 * traversal (`.`/`..`), nor an encoded slash or backslash can turn this public
 * URL into a way to any other API route. Anything else under the prefix is a
 * `404` from the relay rather than a request the API has to judge.
 */
const RELAY_PATH = /^\/api\/public\/gyms\/([^/]+)\/registrations$/;

/**
 * The API path these raw pathname names, or `null` when it is not the one
 * route this relays. The segment is forwarded **as received** — never decoded
 * and re-encoded — so the API sees exactly the reference the website sent.
 */
export function publicRegistrationApiPath(pathname: string): string | null {
  const match = RELAY_PATH.exec(pathname);
  if (!match) return null;
  const gymRef = match[1];
  if (gymRef === '.' || gymRef === '..') return null;
  if (/%2f|%5c/i.test(gymRef)) return null;
  return `/public/gyms/${gymRef}/registrations`;
}

/** Whether the middleware must let this request through untouched. */
export function isPublicRegistrationRelayPath(pathname: string): boolean {
  return RELAY_PATH.test(pathname);
}

/**
 * Everything the relay forwards, and nothing else — deliberately **not**
 * `/api/proxy`'s set (`authorization`, `x-gym-id`, …), which carries a signed-in
 * user's credentials and none of `x-api-key`.
 *
 * `x-forwarded-for` travels because the API rate-limits this route **per
 * client address** (`PUBLIC_REGISTRATION_IP_LIMIT_PER_HOUR`). Keyed on the relay
 * instead, every gym's website would share one hourly budget — see
 * `api/src/domain/forwardedClient.ts` for the hop count that reads it.
 */
export const RELAYED_REQUEST_HEADERS = ['x-api-key', 'content-type', 'x-forwarded-for'] as const;

/** A header name/value source, i.e. what `Headers.entries()` gives. */
export type HeaderEntries = Iterable<readonly [string, string]>;

/**
 * The headers to send upstream, lower-cased and filtered to
 * `RELAYED_REQUEST_HEADERS`. A missing `x-api-key` reaches the API as a missing
 * key and is refused there, never invented here.
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
 * what makes the route answer a 500 rather than fetching `undefined/public/…`.
 */
export function publicRegistrationTarget(
  apiBaseUrl: string | undefined | null,
  apiPath: string,
): string | null {
  const base = (apiBaseUrl ?? '').trim().replace(/\/+$/, '');
  return base === '' ? null : `${base}${apiPath}`;
}

/**
 * How long the relay waits for the API. A registration is one key check, one
 * lookup and one Clerk invitation, so twenty seconds is generous; past it the
 * relay answers a 504 of its own rather than leaving the website to hang.
 */
export const PUBLIC_REGISTRATION_RELAY_TIMEOUT_MS = 20_000;

/** What the relay answers for a path that is not the one route it relays. */
export const RELAY_NOT_ALLOWED_STATUS = 404;

/**
 * What the relay answers when it cannot ask the API. None is ever a 2xx: a
 * website told its sign-up was accepted when it never reached the API would
 * lose that person silently.
 */
export const RELAY_UNCONFIGURED_STATUS = 500;
export const RELAY_UNREACHABLE_STATUS = 502;
export const RELAY_TIMEOUT_STATUS = 504;
