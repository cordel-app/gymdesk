/**
 * The global rate limit in front of the whole API (`app.ts`'s `apiLimiter`):
 * `API_RATE_LIMIT_MAX` requests per 15-minute window.
 *
 * **The budget is per person, not per address** (#1395). Every browser and
 * every phone reaches the API through one of the two Next apps' `/api/proxy`
 * routes, which open a new server-to-server request and forward no
 * `X-Forwarded-For` — so to the API every member is the Members App container
 * and every staff user is the admin container. Keyed on `req.ip`, two people in
 * two houses shared one bucket and locked each other out the moment one of them
 * spent it. `apiRateLimitKey()` therefore keys an authenticated request on the
 * bearer token's subject (the Clerk user id, which is also what the three
 * per-member limiters in `api/me.ts` key on) and falls back to the address
 * only for a request that carries no usable token.
 *
 * The subject is read **without verifying the token**, on purpose: the limiter
 * runs before `tenantContext`, and a bucket key needs no trust — a forged or
 * expired token lands its caller in a bucket of their own, which is exactly what
 * an unknown address gets, and the request is then refused by the auth
 * middleware as before. What this deliberately does *not* do is widen
 * `trust proxy`: `domain/forwardedClient.ts` explains why a global hop count
 * cannot be raised while the API host is still publicly reachable (#1087).
 *
 * 500 is what the limit was before it was configurable and stays the default,
 * so an unset or invalid value changes nothing; a deployment that needs more
 * sets the variable rather than editing the code. The 15-minute window is
 * deliberately not configurable: it is the shape of the limit, and the number
 * alone is the knob.
 */
import { positiveInteger } from './internalRunRateLimit';

/** What `API_RATE_LIMIT_MAX` defaults to when nothing valid is set. */
export const API_RATE_LIMIT_DEFAULT_MAX = 500;

/** The window the limit is counted over, in milliseconds. */
export const API_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

/** Requests one person (or one address) may make per window. Pure apart from the environment read. */
export function apiRateLimitMax(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInteger(env.API_RATE_LIMIT_MAX, API_RATE_LIMIT_DEFAULT_MAX);
}

/**
 * The `sub` claim of a bearer JWT, read from its payload segment with no
 * signature check, or `null` when the header carries nothing shaped like one.
 */
export function bearerTokenSubject(authorization: string | string[] | undefined): string | null {
  const header = Array.isArray(authorization) ? authorization[0] : authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) return null;
  const segments = match[1].split('.');
  if (segments.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
    const sub = payload?.sub;
    return typeof sub === 'string' && sub.trim() !== '' ? sub.trim() : null;
  } catch {
    return null;
  }
}

/**
 * The bucket a request counts against: the signed-in person where there is
 * one, otherwise the address (already normalised by the caller through
 * express-rate-limit's `ipKeyGenerator`, so an IPv6 client is bucketed by
 * subnet exactly as before). The two namespaces are prefixed so a user id and
 * an address can never collide.
 */
export function apiRateLimitKey(authorization: string | string[] | undefined, addressKey: string): string {
  const subject = bearerTokenSubject(authorization);
  return subject ? `user:${subject}` : `ip:${addressKey}`;
}
