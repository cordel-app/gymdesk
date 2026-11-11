/**
 * #2477 stage 3 — the Members App half of the "Draft expires in" indicator.
 *
 * The server decides how many seconds a Draft has left (`expires_in_seconds`,
 * computed with `UTC_TIMESTAMP()`); the browser only counts down from that
 * value, so a wrong local clock can never extend or end a Draft. The functions
 * below are the Admin's (`apps/admin/.../members/draftCountdown.ts`) — the two
 * apps share no frontend module, so the copy is asserted equal by
 * `api/src/test/draft-countdown.unit.test.ts` (#2477 §4: "the same visual
 * treatment and terminology consistently in Admin and Members").
 */
export const DRAFT_WARNING_SECONDS = 15 * 60;

/** When the exact expiry time is shown beside the countdown (§4: under an hour). */
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

/**
 * A Draft the server already reports as expired (`expires_in_seconds` clamped
 * to 0) but whose discard pass has not run yet. The page must not treat it as
 * the member's editable Draft (§4: "do not allow users to continue editing an
 * expired Draft"); the server refuses its writes with `410 draft_expired` anyway.
 */
export function isExpiredDraft(view: { status: string; expires_in_seconds?: number | null } | null): boolean {
  return view?.status === 'draft' && view.expires_in_seconds != null && Number(view.expires_in_seconds) <= 0;
}
