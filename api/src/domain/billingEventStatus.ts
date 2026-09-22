/**
 * #640: the status of a Billing Event.
 *
 * A Billing Event (`billing_events`) may have 0..N Payment Transactions
 * (`payment_requests` rows pointing at it through `billing_event_id`). Its
 * status is the status of the **latest** transaction — so a `failed_billing`
 * event whose retry succeeded reads as `paid` without the append-only ledger
 * row ever being rewritten.
 *
 * When an event has no transaction at all (a `status_changed` row, an
 * `adjustment`, or a `failed_billing` emitted because the member had no stored
 * payment method) the status falls back to what the event type itself says.
 *
 * Pure on purpose: the list endpoint, the details endpoint and the admin UI
 * must not each re-derive this. Unit-tested in
 * `api/src/test/billing-event-status.test.ts`.
 */

/** `payment_requests.status` — the transaction-level vocabulary. */
export type TransactionStatus = 'pending' | 'completed' | 'failed' | 'expired';

/** The status vocabulary the Billing Events view filters and badges on. */
export type BillingEventStatus = 'paid' | 'failed' | 'pending' | 'scheduled' | 'recorded';

export const BILLING_EVENT_STATUSES = ['paid', 'failed', 'pending', 'scheduled', 'recorded'] as const;

/**
 * Maps a transaction status onto the event status it implies. `expired` is a
 * payment that was offered and never completed, which for the purposes of the
 * payment actions is the same "rejected" state as `failed`.
 */
export function statusFromTransaction(txStatus: string | null | undefined): BillingEventStatus | null {
  switch (txStatus) {
    case 'completed': return 'paid';
    case 'failed':
    case 'expired':   return 'failed';
    case 'pending':   return 'pending';
    default:          return null;
  }
}

/** Fallback for an event with no transactions: read the event type itself. */
export function statusFromEventType(eventType: string): BillingEventStatus {
  switch (eventType) {
    case 'recurring_payment':
    case 'payment_recorded': return 'paid';
    case 'failed_billing':   return 'failed';
    default:                 return 'recorded';
  }
}

/**
 * The event's status: its latest transaction's status when it has one,
 * otherwise what the event type implies.
 */
export function deriveBillingEventStatus(
  eventType: string,
  latestTransactionStatus: string | null | undefined,
): BillingEventStatus {
  return statusFromTransaction(latestTransactionStatus) ?? statusFromEventType(eventType);
}

/**
 * Retry Payment and Manual payment are offered only for a failed/rejected
 * event (issue §1: "Do not show payment actions for events where they are not
 * applicable"). A paid, pending or purely informational event offers neither.
 */
export function isPaymentActionable(status: BillingEventStatus): boolean {
  return status === 'failed';
}
