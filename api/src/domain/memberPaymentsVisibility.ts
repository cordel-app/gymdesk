/**
 * #3435 — which Billing Events the Member card's **Payments History and
 * Forecast** chart plots (`domain/paymentsTimeline.ts`), decided in one place.
 * Since stage 2 it is the chart's rule alone: the tab's Billing Event tables
 * read the whole ledger, a cancelled event listed under Past.
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
 * It filters the chart only: nothing is deleted or rewritten, and every Billing
 * Event table (the tab's, the staff list, the audit views) keeps listing every event.
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

export type PaymentAlert = 'failed' | 'pending';

/** A failed or pending payment point is marked; every other status is not. */
export function paymentAlert(status: string | null): PaymentAlert | null {
  return status === 'failed' || status === 'pending' ? status : null;
}
