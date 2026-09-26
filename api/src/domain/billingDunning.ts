/**
 * #785 — the nightly billing run's dunning rule, as a pure function.
 *
 * Until this ticket a rejected recurring charge cost the gym a provider fee and
 * a `failed_billing` ledger row **every night, for ever**: the run leaves
 * `next_billing_date` where it was, so the same assignment is selected again
 * the next night, and nothing ever escalated. The rule that replaces it is the
 * one #640 Q3 already settled for the *manual* Retry — one more attempt, then
 * pause the assignment — moved onto the unattended run, where the second
 * attempt is the **next run day** rather than a second call in the same loop:
 * a card declined seconds ago declines again, so retrying immediately only buys
 * a second fee.
 *
 * ## What counts
 *
 * Only a **provider rejection** — the provider answered, and the answer was
 * no. The two other things the run records as `failed_billing` do not count,
 * and `classifyRunFailure()` below is the single place that says so:
 *
 *   - `provider_error` — the provider threw, timed out or never answered. The
 *     ticket is explicit ("A provider exception is not a rejection: it does not
 *     count toward the pause"), and the reason is that the charge's outcome is
 *     *unknown*: it may have settled. Pausing a member because our side could
 *     not reach Monei twice would be punishing them for our outage, and the
 *     nightly run of a gym behind a flaky network would pause its whole book.
 *   - `no_payment_method` — the assignment has a `payment_methods` row (the run
 *     INNER JOINs it) but no usable token/sequence pair, so nothing was
 *     attempted. There is no decline to escalate; what it needs is a member who
 *     re-enters a card, which pausing does not bring about. It stays visible as
 *     a `failed_billing` event, and #779 is what surfaces it.
 *
 * ## The counter, not a status
 *
 * The count lives in `user_memberships.failed_attempts` (migration 194) and is
 * cleared whenever the cycle moves on — a settled charge, a waived cycle, a
 * staff Retry that succeeds, a manual payment. It therefore counts *consecutive
 * rejections of the cycle `next_billing_date` currently names*, which is what
 * "second consecutive rejection for the same due cycle" means. `paused` is the
 * escalation, and it is a status that already exists: a paused assignment is
 * outside the run's `WHERE status = 'active'`, so it is simply not selected
 * again.
 */

/**
 * Q3 (#640), now also the unattended rule: the charge, then one more on the
 * next run day. The second rejection pauses.
 */
export const MAX_BILLING_RUN_ATTEMPTS = 2;

/** What the run learned about one due assignment it could not charge. */
export type RunFailureKind =
  /** The provider answered and declined. The only kind that escalates. */
  | 'rejected'
  /** The provider threw or never answered — the outcome is unknown. */
  | 'provider_error'
  /** Nothing was attempted: no usable stored token. */
  | 'no_payment_method';

/** True for the one failure kind that moves an assignment towards a pause. */
export function countsTowardPause(kind: RunFailureKind): boolean {
  return kind === 'rejected';
}

export interface RejectionOutcome {
  /** The new value for `user_memberships.failed_attempts`. */
  attempts: number;
  /** Whether this rejection is the one that pauses the assignment. */
  pause: boolean;
}

export interface RejectionContext {
  /** `user_memberships.failed_attempts` as the row was read. */
  previousAttempts: unknown;
  /**
   * Whether a rejection for this assignment was already recorded **today**
   * (UTC), i.e. `DATE(last_failed_at) = UTC_DATE()`, computed in SQL so no
   * DATETIME ever has to survive a timezone conversion in JS.
   *
   * This is what makes the retry the *next run day* rather than "the next time
   * the run happens to execute". Normally the two are the same — the second
   * daily attempt (#781) finds the day's run completed and does nothing. But a
   * first run that **crashed** leaves the day open, and the 10:00 UTC attempt
   * then becomes the day's real run: for a row the crashed one had already
   * charged, that is a second attempt four hours later against the same
   * declined card. Counting it would pause the member on what the ticket
   * explicitly excludes ("not immediately: a same-night second attempt hits the
   * same declined card"). So a same-day repeat is still recorded in the ledger
   * and still re-stamps `last_failed_at` — it simply does not advance the count.
   */
  alreadyRejectedToday: boolean;
}

/**
 * Normalises whatever the column hands back. mysql2 may give a `string` for an
 * INT depending on the driver's type casting, the column is only NOT NULL from
 * migration 194 onwards (a row read mid-deploy can still be `null`), and a
 * negative or non-numeric value must not turn into `NaN` arithmetic that then
 * never reaches the threshold. Anything unreadable counts as "no rejections
 * behind this one", which errs towards charging once more rather than pausing a
 * paying member on bad data.
 */
export function toAttemptCount(value: unknown): number {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), MAX_BILLING_RUN_ATTEMPTS);
}

/**
 * Records one provider rejection against an assignment's dunning state.
 *
 * Call it only for a rejection (see `countsTowardPause`) — it takes the previous
 * count, not the failure kind, precisely so that the caller has to make that
 * decision explicitly rather than passing every failure through.
 */
export function registerRejection(ctx: RejectionContext): RejectionOutcome {
  const previous = toAttemptCount(ctx.previousAttempts);
  if (ctx.alreadyRejectedToday) {
    // A repeat within the same run day never escalates. It still counts as at
    // least one rejection, so an assignment whose counter was somehow clear
    // does not come out of this with nothing recorded.
    const attempts = Math.max(previous, 1);
    return { attempts, pause: false };
  }
  const attempts = Math.min(previous + 1, MAX_BILLING_RUN_ATTEMPTS);
  return { attempts, pause: attempts >= MAX_BILLING_RUN_ATTEMPTS };
}
