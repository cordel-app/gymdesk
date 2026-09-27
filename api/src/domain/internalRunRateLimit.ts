/**
 * The per-route rate limit in front of the internal run endpoints (#783):
 * `POST /billing/run`, `POST /billing/cleanup` and `POST /recurring-bookings/run`.
 *
 * Those routes are authenticated by one thing only — the `X-Internal-Secret`
 * header, compared by each router's `checkInternalSecret()`. Until #783 the
 * `/billing/` half also sat behind an nginx allowlist of GitHub Actions IPs;
 * that allowlist was removed (it covered one of the two endpoints, guarded
 * nothing the secret does not, and decayed by hand). What it did incidentally
 * provide — an attacker could not reach the route at all — is replaced here by
 * a budget small enough that the secret cannot be ground from one address at
 * the global limiter's 500 requests per 15 minutes.
 *
 * Only a **401** spends the budget. The limiter exists to stop someone guessing
 * the secret, and a guess is what a 401 answers; a caller holding the secret
 * never consumes it, so #781's two daily attempts (and a run the guard answers
 * with `429 in_progress` or `200 already_completed_today`) can never lock the
 * real workflow out. Once the budget is spent, every request from that address
 * is refused with 429 until the window ends — including one carrying the right
 * secret, which is the point.
 */

/** What `INTERNAL_RUN_RATE_LIMIT_MAX` defaults to when nothing valid is set. */
export const INTERNAL_RUN_RATE_LIMIT_DEFAULT_MAX = 10;

/** What `INTERNAL_RUN_RATE_LIMIT_WINDOW_MINUTES` defaults to when nothing valid is set. */
export const INTERNAL_RUN_RATE_LIMIT_DEFAULT_WINDOW_MINUTES = 15;

export interface InternalRunRateLimitConfig {
  /** Failed-secret attempts one address may make per window. */
  limit: number;
  /** The window, in milliseconds. */
  windowMs: number;
}

/**
 * A positive whole number from the environment, or `fallback`. `0`, a
 * negative, a fraction below 1 and anything non-numeric fall back rather than
 * being honoured: a `0` limit would refuse every call (the nightly run
 * included), and a `0` window would disable the limiter altogether.
 */
function positiveInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}

/**
 * The limiter's configuration, read from `env` (the process environment by
 * default). Pure apart from that read, so it is unit-tested with a plain object.
 */
export function internalRunRateLimitConfig(
  env: NodeJS.ProcessEnv = process.env,
): InternalRunRateLimitConfig {
  const limit = positiveInteger(env.INTERNAL_RUN_RATE_LIMIT_MAX, INTERNAL_RUN_RATE_LIMIT_DEFAULT_MAX);
  const minutes = positiveInteger(
    env.INTERNAL_RUN_RATE_LIMIT_WINDOW_MINUTES,
    INTERNAL_RUN_RATE_LIMIT_DEFAULT_WINDOW_MINUTES,
  );
  return { limit, windowMs: minutes * 60 * 1000 };
}

/**
 * Whether a response spends the budget: only a 401, i.e. a wrong or missing
 * `X-Internal-Secret`.
 */
export function spendsInternalRunBudget(statusCode: number): boolean {
  return statusCode === 401;
}
