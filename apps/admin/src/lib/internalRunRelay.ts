/**
 * #1086 — the GitHub Actions nightly runs reach the API through the **admin
 * app**, so GitHub's runners no longer need a public API.
 *
 * This module is the **decision** half: which paths may be relayed, where they
 * are relayed to, what crosses the boundary, and what the relay answers when it
 * cannot reach the API. It is pure — no `fetch`, no `node:http`, no
 * `next/server`, no environment read of its own — so every rule below is
 * assertable without a server, a secret or a scheduled run.
 * `app/api/internal/[...path]/route.ts` is the glue and
 * `lib/internalRunUpstream.ts` the transport; neither decides anything, the
 * same split #1073, #1074 and #1085 used for the same reason.
 *
 * The relay **authenticates nothing**. `BILLING_INTERNAL_SECRET` and
 * `RECURRING_BOOKINGS_INTERNAL_SECRET` stay in the API, whose routers compare
 * the `X-Internal-Secret` header themselves (`checkInternalSecret()`), so a
 * wrong secret is still a `401` **from the API**, relayed as such — and it still
 * spends the internal-run budget #783 put in front of those routes. The relay is
 * a transport, never a second trust boundary.
 */

/** The admin-app path prefix the workflows call (`https://admin.…` + this). */
export const INTERNAL_RUN_RELAY_PATH = '/api/internal';

/**
 * The only paths that may be relayed, as the API spells them. An explicit
 * allowlist rather than a pass-through: this prefix is public (the workflows
 * carry a shared secret, not a Clerk session), so anything not named here must
 * be a `404` from the relay rather than a request the API has to judge.
 *
 * These are exactly the four `POST`s in `.github/workflows/billing-run.yml` and
 * `recurring-booking-run.yml`. A fifth internal run is added here and nowhere
 * else.
 */
export const INTERNAL_RUN_API_PATHS = [
  '/billing/run',
  '/billing/cleanup',
  '/promotion-lifecycle/run',
  '/recurring-bookings/run',
] as const;

/**
 * Everything the relay forwards, and nothing else — deliberately **not**
 * `/api/proxy`'s set, which carries `authorization`, `x-gym-id`, `x-center-id`,
 * `x-impersonate-as` and `x-locale`: a caller's own credentials, which these
 * routes neither read nor should ever be handed. No cookie, no authorization
 * and no `host` crosses this boundary.
 *
 * `x-forwarded-for` travels because the API rate-limits these routes **per
 * client address** and only a failed secret spends the budget (#783). Keyed on
 * the relay instead, a handful of wrong guesses from anywhere would lock the
 * nightly run out of a budget it shares with every other caller — see
 * `api/src/domain/forwardedClient.ts` for the hop count that reads it.
 */
export const RELAYED_REQUEST_HEADERS = [
  'x-internal-secret',
  'content-type',
  'x-forwarded-for',
] as const;

/** A header name/value source, i.e. what `Headers.entries()` gives. */
export type HeaderEntries = Iterable<readonly [string, string]>;

/**
 * The headers to send upstream, lower-cased and filtered to
 * `RELAYED_REQUEST_HEADERS`. A header the request does not carry is simply
 * absent: a missing `x-internal-secret` must reach the API as a missing secret
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
 * The API path these segments name, or `null` when they name none of the four.
 * `null` is what makes the route answer a `404` of its own rather than passing
 * the request on — the acceptance criterion's "a path outside the allowlist is
 * a 404 from the proxy".
 *
 * Matched on the whole joined path, so neither a prefix (`/billing`) nor a
 * traversal (`/billing/run/../../gyms`) nor a case variant resolves to one of
 * them.
 */
export function internalRunApiPath(segments: readonly string[] | undefined): string | null {
  if (!segments || segments.length === 0) return null;
  if (segments.some((segment) => segment === '' || segment.includes('/'))) return null;
  const path = `/${segments.join('/')}`;
  return (INTERNAL_RUN_API_PATHS as readonly string[]).includes(path) ? path : null;
}

/**
 * The URL to relay to, or `null` when the API base is not configured. `null` is
 * what makes the route answer a 500 rather than requesting
 * `undefined/billing/run` — a misconfigured relay has to be a failure the
 * workflow reports in red, not a 200 that reads as a night nobody was charged on.
 */
export function internalRunTarget(
  apiBaseUrl: string | undefined | null,
  apiPath: string,
): string | null {
  const base = (apiBaseUrl ?? '').trim().replace(/\/+$/, '');
  return base === '' ? null : `${base}${apiPath}`;
}

/**
 * How long the relay waits for the API, in milliseconds.
 *
 * `POST /recurring-bookings/run` is allowed **600 s** by its workflow, and a
 * relay that gave up first would report a run the API actually completed as a
 * failure — the worst outcome available here, since the guard would then refuse
 * the retry as `already_completed_today`. So the default sits above the longest
 * `--max-time` in `.github/workflows/`: `curl` is always the one that gives up
 * first, and the workflow's own error message is what a person reads.
 *
 * It also has to be set deliberately rather than inherited: Node's global
 * `fetch` would abandon a response whose headers take more than 300 s, which is
 * inside this window, and that is why the transport half uses `node:http`.
 */
export const INTERNAL_RUN_RELAY_TIMEOUT_MS_DEFAULT = 660_000;

/**
 * The timeout from the environment, or the default. A non-numeric value, a
 * fraction and anything at or below zero fall back rather than being honoured:
 * a `0` timeout would abort every run instantly, including the one night it
 * mattered.
 */
export function internalRunRelayTimeoutMs(env: Record<string, string | undefined>): number {
  const raw = env.INTERNAL_RUN_RELAY_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return INTERNAL_RUN_RELAY_TIMEOUT_MS_DEFAULT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return INTERNAL_RUN_RELAY_TIMEOUT_MS_DEFAULT;
  return n;
}

/** What the relay answers for a path outside `INTERNAL_RUN_API_PATHS`. */
export const RELAY_NOT_ALLOWED_STATUS = 404;

/** What the relay answers when `CORDEL_FITNESS_API_URL` is not configured. */
export const RELAY_UNCONFIGURED_STATUS = 500;

/** What the relay answers when it never reached the API. */
export const RELAY_UNREACHABLE_STATUS = 502;

/**
 * What the relay answers when the API took longer than the timeout above.
 * A 504 rather than a 502: the run may well be executing, which is a different
 * thing for a person reading the workflow log to know.
 */
export const RELAY_TIMEOUT_STATUS = 504;
