// #1862 — which of a member's own purchased Products the Members App lists, and
// what each one can do. Pure: dates are 'YYYY-MM-DD' strings in the gym's own
// calendar, and every field is the purchase's own stored copy (#635 §16).
//
// The visibility rule is the owner's, word for word:
//  - Active: always visible, whatever its end date;
//  - Pending Payment: visible, and payable, so the member can finish paying;
//  - Cancelled: visible only while its end date is strictly later than today;
//  - anything else (draft, failed payment): hidden.
// A cancelled purchase's end date is `valid_until`, else the day it was
// cancelled (`endDateOnCancel()`, #1693) — the entitlement ends that day.

import { endDateOnCancel } from './productValidity';

export interface OwnPurchaseRow {
  status: string;
  valid_until: string | null;
  cancelled_on: string | null;
}

export type OwnPurchaseState = 'active' | 'pending_payment' | 'cancelled';

/**
 * The member-facing state of a purchase, or `null` when the member is not shown it.
 *
 * #3358 stage 2 — a **recurring line** carries the shared cancellation lifecycle in its `status`
 * (`to_be_canceled`, `to_be_canceled_immediately`, `active_cancel_at_period_end`, `cancelled`), and
 * it is read only while it is still entitled (its end date has not passed), so every one of those is
 * the member's Product: a mark awaiting staff's Save & Pay is not a state the member is shown, and a
 * committed cancellation still grants the Product until its End Date. That is exactly how such a
 * line read before this ticket, when the pending removal was a flag beside an `active` status.
 */
export function ownPurchaseState(
  row: OwnPurchaseRow, today: string, opts: { recurring?: boolean } = {},
): OwnPurchaseState | null {
  if (opts.recurring) return row.status === 'pending_payment' ? 'pending_payment' : 'active';
  // A cancelled purchase is never payable, even one cancelled while its payment
  // was still outstanding (#1919): the cancellation outranks the pending status.
  if (row.status === 'pending_payment' && !row.cancelled_on) return 'pending_payment';
  if (row.status !== 'active' && row.status !== 'pending_payment') return null;
  if (!row.cancelled_on) return 'active';
  return endDateOnCancel(row.valid_until, row.cancelled_on) > today ? 'cancelled' : null;
}

/** The end date a card shows: the purchase's last valid day, else none. */
export function ownPurchaseEndDate(row: OwnPurchaseRow): string | null {
  if (row.cancelled_on) return endDateOnCancel(row.valid_until, row.cancelled_on);
  return row.valid_until ?? null;
}
