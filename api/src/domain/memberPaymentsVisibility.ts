/**
 * #3435 — which Billing Events the Member card's **Payments** view presents,
 * decided in one place for its chart (`domain/paymentsTimeline.ts`) and its
 * payment-history table (`GET /payments/billing-events?exclude_cancelled=true`).
 *
 * Two answers, each the rule rather than the implementation:
 *
 *  - **A cancelled attempt that moved no money is not a payment**, so it is not
 *    presented: an event whose status is cancelled (`billing_events.cancelled_at`,
 *    a 24h-expired checkout included, or its latest attempt `cancelled`, #3309)
 *    with no completed payment attempt. A cancelled event that **did** collect
 *    money stays (#2533: the money is real, refundable and receiptable), and so
 *    does every failed, pending, paid, waived or scheduled event. The decision is
 *    read from the attempts (`payment_requests`), never from a display label.
 *  - **A failed or pending attempt is flagged**, never hidden and never read as
 *    paid: `paymentAlert()` answers which of the two a point carries, off the
 *    event's ledger status, which is the latest attempt's (`ledgerEventStatus()`).
 *
 * It filters presentation only: nothing is deleted or rewritten, and the staff
 * Billing Events list and the audit views keep listing every event.
 */

export interface PaymentsVisibilityInput {
  /** `billing_events.cancelled_at IS NOT NULL`. */
  cancelled: boolean;
  /** The latest attempt's own status, `null` when the event has none. */
  latestTxStatus: string | null;
  /** Whether a payment attempt of the event completed (money collected). */
  collected: boolean;
}

export function isHiddenFromMemberPayments(e: PaymentsVisibilityInput): boolean {
  const cancelled = e.cancelled || e.latestTxStatus === 'cancelled';
  return cancelled && !e.collected;
}

/**
 * The same rule as a SQL predicate over `billing_events be` — true for an event
 * the Member Payments view hides. Kept beside the function so the two cannot drift.
 */
export const HIDDEN_FROM_MEMBER_PAYMENTS_SQL = `(
  (be.cancelled_at IS NOT NULL
    OR (SELECT prx.status FROM payment_requests prx
         WHERE prx.billing_event_id = be.id
         ORDER BY prx.created_at DESC, prx.id DESC LIMIT 1) = 'cancelled')
  AND NOT EXISTS (SELECT 1 FROM payment_requests prc
                   WHERE prc.billing_event_id = be.id
                     AND prc.transaction_type = 'payment' AND prc.status = 'completed')
)`;

export type PaymentAlert = 'failed' | 'pending';

/** A failed or pending payment point is marked; every other status is not. */
export function paymentAlert(status: string | null): PaymentAlert | null {
  return status === 'failed' || status === 'pending' ? status : null;
}
