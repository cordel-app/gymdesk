/**
 * A short-lived, de-duplicating lookup in front of Clerk's `users.getUser()`.
 *
 * `tenantContext` and `requireSuperadmin` read the caller's Clerk user (its
 * `platform_role` and display name) on **every** gym-scoped request. A single
 * screen fires several of those in parallel, so with a few tabs open the API
 * spent Clerk's Backend API budget (the `ClerkAPIResponseError: Too Many
 * Requests` bursts in the API log) and every caller, whatever their own request
 * count, was answered 429.
 *
 * What it does, and deliberately nothing else:
 *  - remembers a successful answer for `ttlMs`, keyed on the user id;
 *  - lets concurrent callers for the same id share one in-flight request;
 *  - never remembers a failure, so a Clerk outage or a 429 is retried by the
 *    next request instead of being replayed for a minute;
 *  - is bounded, so a stream of distinct ids cannot grow it without limit.
 *
 * The cost is that a change of `platform_role` or of the display name reaches
 * the API after at most `ttlMs`. `0` disables it (a straight pass-through), which
 * is what the test suite runs with so a test that changes a role between two
 * requests keeps meaning what it says.
 */

export const CLERK_USER_CACHE_DEFAULT_TTL_SECONDS = 60;
const MAX_ENTRIES = 1000;

/** `CLERK_USER_CACHE_TTL_SECONDS`: a non-negative integer; unset/invalid → default (0 under test). */
export function clerkUserCacheTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CLERK_USER_CACHE_TTL_SECONDS;
  if (raw !== undefined && /^\d+$/.test(raw.trim())) return Number(raw.trim()) * 1000;
  return env.NODE_ENV === 'test' ? 0 : CLERK_USER_CACHE_DEFAULT_TTL_SECONDS * 1000;
}

export function createCachedLookup<T>(
  fetcher: (id: string) => Promise<T>,
  options: { ttlMs: number; now?: () => number; maxEntries?: number },
): (id: string) => Promise<T> {
  const { ttlMs, now = Date.now, maxEntries = MAX_ENTRIES } = options;
  if (ttlMs <= 0) return fetcher;

  const values = new Map<string, { value: T; expiresAt: number }>();
  const inFlight = new Map<string, Promise<T>>();

  return async (id: string) => {
    const hit = values.get(id);
    if (hit && hit.expiresAt > now()) return hit.value;

    const pending = inFlight.get(id);
    if (pending) return pending;

    const request = fetcher(id)
      .then((value) => {
        if (values.size >= maxEntries) {
          const oldest = values.keys().next().value;
          if (oldest !== undefined) values.delete(oldest);
        }
        values.delete(id);
        values.set(id, { value, expiresAt: now() + ttlMs });
        return value;
      })
      .finally(() => {
        inFlight.delete(id);
      });
    inFlight.set(id, request);
    return request;
  };
}
