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

/**
 * #1459: which payment actions the Billing Events view offers for one event.
 * The one place the answer is decided — the list and the Details view both ask
 * it and the frontend renders flags, so a button can never be offered for an
 * action the route would refuse. The routes still re-check under the event's
 * lock; this only decides what is *offered*.
 *
 * - `payCash` / `payCard`  record money received outside Gymdesk (manual
 *   settlement). Offered on an actionable event, and on a membership's first
 *   payment while it is `pending_payment`.
 * - `firstPayment`  the settlement goes through the membership's own
 *   `record-payment` (it activates the plan), not the failed-event route.
 * - `retry` / `waive`  only on an actionable event: a charge the provider
 *   rejected, or a persisted obligation that is due and uncollected.
 *
 * Closing a modal is not an action and appears nowhere here: there is no
 * "cancel" — an unresolved obligation simply stays unresolved.
 */
export interface PaymentActionInput {
  status: BillingEventStatus;
  eventType: string;
  /** A persisted obligation that is due today or earlier and nothing has collected. */
  scheduledAndDue: boolean;
  /** The event hangs off a membership or a ProductSet (a transaction needs one). */
  linked: boolean;
  membershipStatus: string | null;
  hasMembership: boolean;
  amount: number;
}

export interface PaymentActions {
  retry: boolean;
  payCash: boolean;
  payCard: boolean;
  waive: boolean;
  firstPayment: boolean;
}

export function paymentActionsFor(i: PaymentActionInput): PaymentActions {
  const priced = i.amount > 0;
  const actionable = (isPaymentActionable(i.status) || i.scheduledAndDue)
    && i.linked && priced && !isNonObligationEvent(i.eventType);
  const firstPayment = i.status === 'pending' && i.eventType === 'payment_recorded'
    && i.membershipStatus === 'pending_payment' && i.hasMembership && priced;
  return {
    retry: actionable,
    waive: actionable,
    payCash: actionable || firstPayment,
    payCard: actionable || firstPayment,
    firstPayment: firstPayment && !actionable,
  };
}

/**
 * #779: a Billing Event is **awaiting action** when its derived status is
 * `failed` — the charge was rejected (or expired) and neither a successful
 * Retry Payment nor a Manual payment has settled it since. Both resolutions
 * append a `completed` transaction to the same event, which makes it derive to
 * `paid` and drops it out of the count without the ledger row being touched.
 *
 * The staff's work queue is therefore exactly the Billing Events list filtered
 * by `status=failed`: the sidebar badge and the dashboard card count what that
 * list shows, never a second definition of it.
 */
export function isAwaitingAction(
  eventType: string,
  latestTransactionStatus: string | null | undefined,
): boolean {
  // #1325 PR 2: a one-off purchase and a card verification are not
  // obligations. A failed purchase is the member's to retry from the catalogue
  // (a new request), never the staff's queue, and a verification owes nothing.
  if (isNonObligationEvent(eventType)) return false;
  return deriveBillingEventStatus(eventType, latestTransactionStatus) === 'failed';
}

/**
 * Event types that record money or a check that is not a membership/ProductSet
 * obligation: they are shown in the ledger but never counted as revenue
 * owed, never queued for staff and never offered Retry or Manual payment.
 */
export const NON_OBLIGATION_EVENT_TYPES = ['product_purchase', 'card_verification'] as const;

export function isNonObligationEvent(eventType: string): boolean {
  return (NON_OBLIGATION_EVENT_TYPES as readonly string[]).includes(eventType);
}

/**
 * #787: which Billing Events may carry a receipt ("factura simplificada").
 *
 * The rule is *money actually received*, not the shape of the ledger row. A
 * Billing Event is the charge; the `payment_requests` rows pointing at it are
 * the attempts to settle it, so the question "was this paid?" is already
 * answered by `deriveBillingEventStatus` and must not be re-derived here.
 *
 * That single predicate covers the three ways money arrives, without a special
 * case for any of them:
 *
 *  - `payment_recorded` — a front-desk cash payment (no transaction at all, so
 *    the event type itself answers) or a member's completed checkout, which is
 *    the only branch of the webhook that writes this row. Receipt-able since
 *    #114; unchanged.
 *  - `recurring_payment` — the nightly run's settled charge. Its success branch
 *    writes the event and a `completed` transaction in one transaction, so it
 *    always has one. This is what #787 adds.
 *  - `failed_billing` whose latest transaction is `completed` — a rejected
 *    charge later settled by the staff's Retry or Manual payment (#640). Those
 *    actions deliberately never append a second Billing Event, so the money is
 *    recorded against the failed row and there is nothing else to issue against.
 *    It falls out of the predicate rather than being special-cased, which is
 *    what the ticket asked us to confirm.
 *
 * Everything else is refused: a `waived_billing` (no money moved — a waived
 * cycle calls no provider and writes no transaction), an `adjustment`, a
 * `status_changed`, and any of the three above whose latest transaction says
 * the payment failed, expired or is still pending.
 */
const RECEIPTABLE_EVENT_TYPES = ['payment_recorded', 'recurring_payment', 'failed_billing', 'product_purchase'] as const;

export function isReceiptableEvent(
  eventType: string,
  latestTransactionStatus: string | null | undefined,
): boolean {
  if (!RECEIPTABLE_EVENT_TYPES.includes(eventType as any)) return false;
  return deriveBillingEventStatus(eventType, latestTransactionStatus) === 'paid';
}

/**
 * Why a receipt was refused, for the route's `400` body. Returns `null` when
 * the event is receipt-able, so a caller can use it as the whole check.
 *
 * Kept beside the predicate so the two can never disagree: a reason that says
 * "not paid" for an event the predicate accepted would be worse than no reason
 * at all.
 */
export function receiptRefusalReason(
  eventType: string,
  latestTransactionStatus: string | null | undefined,
): string | null {
  if (isReceiptableEvent(eventType, latestTransactionStatus)) return null;
  if (!RECEIPTABLE_EVENT_TYPES.includes(eventType as any)) {
    return `Receipts can only be issued for a payment that was received; `
      + `'${eventType}' events record no payment`;
  }
  const status = deriveBillingEventStatus(eventType, latestTransactionStatus);
  return `Receipts can only be issued for a payment that was received; `
    + `this event's payment is '${status}'`;
}
