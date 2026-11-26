/**
 * #2099 — the Member card's **Payments** tab, decided in one JSX-free place.
 *
 * The rows are `GET /payments/billing-events?member_id=` — the actual ledger,
 * whose `status` the API derives (`deriveBillingEventStatus()`). Nothing is
 * projected there any more (every future obligation is a persisted
 * `is_scheduled` row), so a simulation can never reach this tab; the tab only
 * decides which section a row belongs to and never recomputes a status.
 */

export interface PaymentsTabEvent {
  id: number | null;
  type?: 'real' | 'virtual';
  billing_date: string;
  created_at: string | null;
  amount: string | null;
  event_type: string;
  /** #3332: null when the event type records no payment. */
  status: string | null;
  plan_name: string | null;
}

/**
 * Statuses of an actual event that still awaits a settlement. Every other
 * status is resolved and listed under Past — `cancelled` included (#3435
 * stage 2): the API reports a cancelled event as `cancelled` even when it was
 * a persisted obligation (`ledgerEventStatus()`), and the tab hides none.
 */
export const UNRESOLVED_STATUSES = ['scheduled', 'failed', 'pending'] as const;

export function isUnresolvedEvent(status: string | null): boolean {
  return status != null && (UNRESOLVED_STATUSES as readonly string[]).includes(status);
}

/** Only persisted ledger rows are shown; a projected one (no id) never is. */
export function isActualEvent(ev: Pick<PaymentsTabEvent, 'id' | 'type'>): boolean {
  return ev.id != null && ev.type !== 'virtual';
}

/**
 * Unresolved events first (failed, then pending, then the scheduled ones soonest
 * first), everything else under Past billing events, newest first.
 */
export function splitPaymentsTabEvents(events: readonly PaymentsTabEvent[]): {
  unresolved: PaymentsTabEvent[];
  past: PaymentsTabEvent[];
} {
  const actual = events.filter(isActualEvent);
  const rank = (s: string | null) => (s === 'failed' ? 0 : s === 'pending' ? 1 : 2);
  const unresolved = actual
    .filter((e) => isUnresolvedEvent(e.status))
    .sort((a, b) => rank(a.status) - rank(b.status) || (a.billing_date < b.billing_date ? -1 : a.billing_date > b.billing_date ? 1 : 0));
  const past = actual
    .filter((e) => !isUnresolvedEvent(e.status))
    .sort((a, b) => (a.billing_date < b.billing_date ? 1 : a.billing_date > b.billing_date ? -1 : (b.id ?? 0) - (a.id ?? 0)));
  return { unresolved, past };
}

/**
 * #2778 — the newest past event is shown on its own under *Last billing event*
 * and the rest under *Past billing events*, so it is never listed twice. The
 * input is `splitPaymentsTabEvents()`' `past` (already newest first); the order
 * of the rest is unchanged. No past events means no last one (`null`).
 */
export function splitPastEvents<T>(past: readonly T[]): { last: T | null; rest: T[] } {
  return past.length === 0 ? { last: null, rest: [] } : { last: past[0], rest: past.slice(1) };
}

/** #2778 — the three sections' initial open state: Past is the only one closed. */
export const PAYMENTS_TAB_INITIAL_OPEN = { unresolved: true, last: true, past: false } as const;

/**
 * #2778 follow-up — the Billing Event rows open when the tab first loads: the
 * one under *Last billing event*, so its Billing Event lines are read without
 * a click. Nothing else starts open, and no last event means none.
 */
export function initialExpandedEventIds(last: Pick<PaymentsTabEvent, 'id'> | null): number[] {
  return last?.id != null ? [last.id] : [];
}

/** The locale key (in `members`) a status reads under, `null` for an unknown one. */
export function paymentStatusKey(status: string | null): string | null {
  return status != null && ['paid', 'failed', 'pending', 'scheduled', 'waived'].includes(status) ? `payments_status_${status}` : null;
}

/** `StatusBadge`-style tone of a status; failed and scheduled stand out. */
export function paymentStatusTone(status: string | null): 'danger' | 'info' | 'warning' | 'success' | 'neutral' {
  switch (status) {
    case 'failed': return 'danger';
    case 'scheduled': return 'info';
    case 'pending': return 'warning';
    case 'paid': return 'success';
    default: return 'neutral';
  }
}

const EVENT_TYPES = [
  'payment_recorded', 'recurring_payment', 'failed_billing', 'waived_billing', 'charge_created',
  'adjustment', 'product_purchase', 'card_verification',
];

/** The locale key (in `members`) an event type reads under, `null` for an unknown one. */
export function paymentEventTypeKey(eventType: string): string | null {
  return EVENT_TYPES.includes(eventType) ? `payments_event_${eventType}` : null;
}
