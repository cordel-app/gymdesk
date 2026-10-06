/**
 * #1166 — Grafana Cloud's run-freshness alerts (#872) read `GET /health/runs`
 * through the **admin app**, so they no longer need a public API (#1087).
 *
 * This module is the **decision** half: where the relay forwards to, how long it
 * waits, and what it answers when it cannot. It is pure — no `fetch`, no
 * `next/server`, no environment read of its own — so every rule below is
 * assertable without a server. `app/api/health/runs/route.ts` is the I/O half
 * and decides nothing, the split #1085 and #1086 use for the same reason.
 *
 * It is **one path, not a pass-through**: the relay names `/health/runs` and
 * nothing else, and takes no path from the request, so this public URL cannot
 * be used to reach any other unauthenticated API route.
 *
 * It **forwards no request header**. The API route reads none — it is
 * unauthenticated by design (#782) and answers the same thing to everyone — and
 * a caller's own headers have no business crossing into the private network.
 * The consequence is stated rather than worked around: the API's global
 * limiter keys on the address it sees, which for this request is the admin
 * app, the same key every `/api/proxy` call already shares. Two Grafana rules
 * every 5 minutes are far below that budget, so no per-route hop setting
 * (#1083/#1086's device) is warranted here.
 */

/** The API path this relays to. One spelling, used to build the target URL. */
export const HEALTH_RUNS_API_PATH = '/health/runs';

/** The admin-app path Grafana is pointed at (`https://admin.…` + this). */
export const HEALTH_RUNS_RELAY_PATH = '/api/health/runs';

/**
 * The URL to relay to, or `null` when the API base is not configured. `null` is
 * what makes the route answer a 500 rather than fetching `undefined/health/runs`.
 */
export function healthRunsTarget(apiBaseUrl: string | undefined | null): string | null {
  const base = (apiBaseUrl ?? '').trim().replace(/\/+$/, '');
  return base === '' ? null : `${base}${HEALTH_RUNS_API_PATH}`;
}

/**
 * How long the relay waits for the API. The route is two indexed reads, so ten
 * seconds is generous; past it the relay answers a 504 of its own rather than
 * leaving the alert rule to hit Grafana's own query timeout.
 */
export const HEALTH_RUNS_RELAY_TIMEOUT_MS = 10_000;

/**
 * What the relay answers when it cannot ask the API. None is ever a 200: the
 * alert rules are set to **Error → Alerting**, so an unreachable API must read
 * as a failure, never as a fresh run.
 */
export const RELAY_UNCONFIGURED_STATUS = 500;
export const RELAY_UNREACHABLE_STATUS = 502;
export const RELAY_TIMEOUT_STATUS = 504;
