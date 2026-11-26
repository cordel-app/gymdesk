/**
 * #3297 — what the Members App's Payments view is told about one Billing Event,
 * beyond the ledger row itself. Pure; `GET /me/billing-events` is its one caller
 * and the staff Billing Events list asks `ledgerEventStatus()` too, so the two
 * apps cannot call one persisted obligation two different things.
 *
 * Three answers, each the rule rather than the implementation:
 *
 *  - **A persisted, not-yet-executed obligation is `scheduled`** (`is_scheduled
 *    = 1`), whatever its event type says. The staff list has said so since
 *    #1325; the member's ledger used to fall back to the event type and read it
 *    as *Recorded*, which is what #3297 §4 / AC 7 forbid.
 *  - **The scheduled execution date is the event's own `billing_date`**, else
 *    the day it was written (a purchase or a manual entry has no billing date:
 *    it was executed when it was recorded). It is a `YYYY-MM-DD` in UTC, the
 *    date the nightly run compares in SQL.
 *  - **Full or partial is decided from money that moved**, never from a
 *    document: a payment is `full` when the latest collected attempt covers the
 *    event's amount and `partial` when it does not; a refund is the refund
 *    summary's own `full` / `partial` (`refundState()`, #2480). An event with
 *    no collected attempt has neither.
 */
import { deriveBillingEventStatus, type BillingEventStatus } from './billingEventStatus';
import { toCents } from './billingEventRefund';

/**
 * The status the ledger reports for an event: a persisted obligation is
 * `scheduled`, unless it was cancelled — #3435 stage 2: a cancelled event is
 * resolved, so `cancelled` wins over the `is_scheduled` flag (it never reads as
 * an obligation still owed, nor sits under *Unresolved*).
 */
export function ledgerEventStatus(
  eventType: string,
  latestTransactionStatus: string | null | undefined,
  cancelled: boolean,
  isScheduled: boolean,
): BillingEventStatus | null {
  if (isScheduled && !cancelled) return 'scheduled';
  return deriveBillingEventStatus(eventType, latestTransactionStatus, cancelled);
}

/** The day an event is (or was) executed on: its billing date, else the day it was written. */
export function scheduledExecutionDate(
  billingDate: Date | string | null | undefined,
  createdAt: Date | string,
): string {
  const pick = billingDate ?? createdAt;
  if (pick instanceof Date) return pick.toISOString().slice(0, 10);
  // A DATE column read as a string is already `YYYY-MM-DD`; a DATETIME string starts with it.
  const text = String(pick);
  if (/^\d{4}-\d{2}-\d{2}/.test(text) && !text.includes('T')) return text.slice(0, 10);
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text.slice(0, 10) : parsed.toISOString().slice(0, 10);
}

export type PaymentCoverage = 'full' | 'partial';

/**
 * Whether the money collected for an event covers its amount. `null` when
 * nothing was collected (no completed payment attempt) or the event records no
 * positive amount.
 */
export function paymentCoverage(
  collected: number | string | null | undefined,
  eventAmount: number | string | null | undefined,
): PaymentCoverage | null {
  if (collected == null || eventAmount == null) return null;
  const paid = toCents(collected);
  const owed = toCents(eventAmount);
  if (paid <= 0 || owed <= 0) return null;
  return paid >= owed ? 'full' : 'partial';
}

/** A refund summary's state as the member's chip reads it; `null` when nothing was refunded. */
export function refundCoverage(state: string | null | undefined): PaymentCoverage | null {
  return state === 'full' || state === 'partial' ? state : null;
}
