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

/** The member-facing state of a purchase, or `null` when the member is not shown it. */
export function ownPurchaseState(row: OwnPurchaseRow, today: string): OwnPurchaseState | null {
  if (row.status === 'pending_payment') return 'pending_payment';
  if (row.status !== 'active') return null;
  if (!row.cancelled_on) return 'active';
  return endDateOnCancel(row.valid_until, row.cancelled_on) > today ? 'cancelled' : null;
}

/** The end date a card shows: the purchase's last valid day, else none. */
export function ownPurchaseEndDate(row: OwnPurchaseRow): string | null {
  if (row.cancelled_on) return endDateOnCancel(row.valid_until, row.cancelled_on);
  return row.valid_until ?? null;
}
