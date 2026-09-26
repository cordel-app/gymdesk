/**
 * When a `pending` payment request may be written off (#789).
 *
 * `payment_requests` carries two deadlines, and conflating them is what cost a
 * member a payment they had already made:
 *
 * 1. **The `page_token` TTL** (10 minutes from creation) bounds how long the
 *    checkout *link* may be opened. It is the only thing the token protects,
 *    and `GET /payment-page/token/:token` consumes the token on the very first
 *    load (`page_token = NULL`).
 * 2. **The request's own lifetime.** Once the page is open the member spends
 *    minutes in the Card Input and a 3DS redirect, and Monei may retry its
 *    webhook later still after a transient 5xx on our side. None of that is
 *    over when the token's ten minutes are.
 *
 * `POST /billing/cleanup` used deadline 1 for both, so a member who opened the
 * page at minute 9 and paid at minute 12 got an `expired` row — which the
 * webhook's `pr.status !== 'pending'` guard then skipped as already processed.
 * Money moved and Gymdesk kept no record of it: no `payment_methods` row, no
 * `next_billing_date`, and the member app still offering "start payment".
 *
 * So the two deadlines are separated here. A request whose page was never
 * opened still expires with its token; one that was opened gets the long,
 * configurable window below and, until it runs out, stays `pending` so a
 * terminal webhook can still land on it.
 */

/** What `PAYMENT_REQUEST_ABANDONED_HOURS` defaults to when nothing is set. */
export const ABANDONED_REQUEST_DEFAULT_HOURS = 24;

/**
 * Floor on the configured window. The whole defect was a deadline shorter than
 * a checkout takes, so a deployment that sets `0` (or a typo that parses as
 * one) must not be able to reintroduce it: below an hour the value is ignored
 * rather than honoured.
 */
export const ABANDONED_REQUEST_MIN_HOURS = 1;

/**
 * How long a payment request whose checkout page was opened stays `pending`
 * before cleanup writes it off as abandoned.
 *
 * Configurable because the right answer belongs to the deployment and to the
 * provider's own retry schedule, not to this code. Read per call rather than
 * captured at import time, so a test — and a change without a restart — sees
 * the current value.
 *
 * Whole hours only: the value is spent as MySQL's `INTERVAL ? HOUR`, which has
 * no use for a fraction, so a configured `1.5` is floored rather than left to
 * the server to interpret.
 */
export function abandonedRequestHours(): number {
  const raw = Number(process.env.PAYMENT_REQUEST_ABANDONED_HOURS);
  if (!Number.isFinite(raw) || raw < ABANDONED_REQUEST_MIN_HOURS) {
    return ABANDONED_REQUEST_DEFAULT_HOURS;
  }
  return Math.floor(raw);
}
