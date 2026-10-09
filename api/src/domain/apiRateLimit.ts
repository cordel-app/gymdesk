/**
 * The global per-IP rate limit in front of the whole API (`app.ts`'s
 * `apiLimiter`): `API_RATE_LIMIT_MAX` requests per 15-minute window.
 *
 * It is one budget per address, and every browser of the admin app reaches the
 * API through the admin app's relay, so a busy development environment (a
 * person clicking through screens, a phone, an emulator and CI at once) spends
 * a single bucket. 500 is what it was before this was configurable and stays
 * the default, so an unset or invalid value changes nothing; a deployment that
 * needs more sets the variable rather than editing the code. The 15-minute
 * window is deliberately not configurable: it is the shape of the limit, and
 * the number alone is the knob.
 */
import { positiveInteger } from './internalRunRateLimit';

/** What `API_RATE_LIMIT_MAX` defaults to when nothing valid is set. */
export const API_RATE_LIMIT_DEFAULT_MAX = 500;

/** The window the limit is counted over, in milliseconds. */
export const API_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

/** Requests one address may make per window. Pure apart from the environment read. */
export function apiRateLimitMax(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInteger(env.API_RATE_LIMIT_MAX, API_RATE_LIMIT_DEFAULT_MAX);
}
