/**
 * #2477 — the "Draft expires in" indicator. The server decides how many seconds
 * a Draft has left (`expires_in_seconds`, its own clock); the browser only counts
 * down from that value, so a wrong local clock can never extend or end a Draft.
 */
export const DRAFT_WARNING_SECONDS = 15 * 60;

/** When the exact expiry time is shown beside the countdown (#2477 §4: under an hour). */
export const DRAFT_EXACT_TIME_SECONDS = 60 * 60;

/** `1h 45m`, `32m`, `5m`, `<1m`; null when there is nothing to count down. */
export function formatDraftRemaining(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 1) return '<1m';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

/** Remaining seconds now, given the server's value at `receivedAtMs`. */
export function remainingNow(serverSeconds: number, receivedAtMs: number, nowMs: number): number {
  return Math.max(0, serverSeconds - Math.floor((nowMs - receivedAtMs) / 1000));
}

export function isDraftWarning(seconds: number): boolean {
  return seconds > 0 && seconds <= DRAFT_WARNING_SECONDS;
}

/** Whether the exact expiry time is shown beside the remaining time. */
export function showsDraftExactTime(seconds: number): boolean {
  return seconds > 0 && seconds < DRAFT_EXACT_TIME_SECONDS;
}
