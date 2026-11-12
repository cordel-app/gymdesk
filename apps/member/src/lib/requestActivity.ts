/**
 * #2683 — how many API requests the Members App has in flight.
 *
 * `apiFetch` / `uploadFetch` (`lib/apiClient.ts`) count each request in and out
 * here, and pull-to-refresh reads the count to know when the page it remounted
 * has finished re-fetching (`isRefreshSettled()` in `lib/pullToRefresh.ts`). It
 * is a counter and nothing else: it stores no response, decides nothing about a
 * request and is never read to gate one.
 */
let inFlight = 0;

export function beginRequest(): void {
  inFlight += 1;
}

export function endRequest(): void {
  inFlight = Math.max(0, inFlight - 1);
}

export function requestsInFlight(): number {
  return inFlight;
}

/** Runs `fn` counted as one request, whatever it resolves or throws. */
export async function trackRequest<T>(fn: () => Promise<T>): Promise<T> {
  beginRequest();
  try {
    return await fn();
  } finally {
    endRequest();
  }
}
