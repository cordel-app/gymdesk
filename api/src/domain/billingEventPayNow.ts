/**
 * #3442 — **Pay now** on a Billing Event: whether staff may start collecting an
 * existing event immediately, and what refuses it. Pure, the one place the rule
 * is decided: the list and the Details read report it as `can_pay_now` /
 * `pay_now_block`, and the two routes ask it again under the event's row lock.
 *
 * Pay now never creates a Billing Event. It settles, or raises an attempt on,
 * the event it was opened on, through the flows #1459 already has: a Members App
 * hosted checkout (a `payment_requests` row on this event) or a staff-confirmed
 * Cash / external card terminal settlement. The stored-card charge stays the
 * existing **Retry Payment** action.
 */
import { BillingEventStatus, isNonObligationEvent } from './billingEventStatus';
import { payFlowFor } from './productSetPayment';
import type { ManualPaymentMethod } from './paymentAttemptMethod';

/** The event states Pay now is offered for (the ledger's status, `scheduled` included). */
export const PAY_NOW_STATUSES: readonly BillingEventStatus[] = ['failed', 'pending', 'scheduled'];

/** Why a Pending payment event cannot be paid: the cart it was checked out from is over. */
export type PayNowBlock = 'cart_cancelled' | 'cart_expired';

export interface PayNowInput {
  /** The ledger status: `ledgerEventStatus()` (a persisted obligation reads `scheduled`). */
  status: BillingEventStatus | null;
  eventType: string;
  /** `billing_events.cancelled_at` is set. */
  cancelled: boolean;
  /** Some attempt of the event completed (money received or waived): terminal. */
  hasCompletedAttempt: boolean;
  /** The event belongs to a Product Set (a transaction needs one). */
  linked: boolean;
  amount: number;
}

/** Whether **Pay now** is offered for the event at all. */
export function payNowOffered(i: PayNowInput): boolean {
  if (i.cancelled || i.hasCompletedAttempt) return false;
  if (i.status == null || !PAY_NOW_STATUSES.includes(i.status)) return false;
  if (isNonObligationEvent(i.eventType)) return false;
  return i.linked && i.amount > 0;
}

export interface PayNowCartInput {
  status: BillingEventStatus | null;
  /** `purchases.status` of the cart the event was checked out from, or null. */
  cartStatus: string | null;
  /** `billing_events.expired_at` is set (the 24-hour checkout expiry). */
  eventExpired: boolean;
  /** The cart is still In Cart and its two-hour clock has run out. */
  cartClockExpired: boolean;
}

/**
 * #3442 comment: a Pending payment event whose cart was cancelled or expired is
 * offered Pay now but refused with the reason, before any method is chosen; the
 * cart is resolved through its own workflow. Other states are not blocked.
 */
export function payNowBlock(i: PayNowCartInput): PayNowBlock | null {
  if (i.status !== 'pending') return null;
  if (i.eventExpired || (i.cartStatus === 'in_cart' && i.cartClockExpired)) return 'cart_expired';
  if (i.cartStatus === 'cancelled') return 'cart_cancelled';
  return null;
}

/** The two flows Pay now runs; a catalogue method with neither is shown unavailable. */
export type PayNowFlow =
  | { flow: 'members_app' }
  | { flow: 'manual'; attemptMethod: ManualPaymentMethod };

export function payNowFlowFor(code: unknown): PayNowFlow | null {
  const f = payFlowFor(code);
  if (!f) return null;
  if (f.flow === 'members_app') return { flow: 'members_app' };
  if (f.flow === 'manual' && f.attemptMethod) return { flow: 'manual', attemptMethod: f.attemptMethod };
  return null;
}

/** A catalogue method as the Pay now modal lists it. */
export function payNowMethodAvailability(code: string): { available: boolean; reason: 'unsupported' | null } {
  return payNowFlowFor(code) ? { available: true, reason: null } : { available: false, reason: 'unsupported' };
}

/**
 * A pending attempt whose hosted page was never opened (`page_token` still set,
 * #789: opening the page is what clears it) cannot have collected money. Its
 * link may be reused while it is still valid; once its token has lapsed it can
 * be expired before a new attempt is raised or a manual settlement recorded.
 */
export interface PendingAttempt {
  id: number;
  status: string;
  pageToken: string | null;
  pageTokenExpiresAt: Date | null;
}

export function reusableCheckout(attempts: readonly PendingAttempt[], now: Date): PendingAttempt | null {
  const usable = attempts.filter((a) => a.status === 'pending' && a.pageToken != null
    && a.pageTokenExpiresAt != null && a.pageTokenExpiresAt.getTime() > now.getTime());
  return usable.sort((a, b) => b.id - a.id)[0] ?? null;
}

/** The never-opened pending attempts that may be closed as `expired` (`unopenedOnly` keeps a live link too). */
export function unopenedPendingAttempts(attempts: readonly PendingAttempt[], now: Date, opts: { includeLive: boolean }): number[] {
  return attempts
    .filter((a) => a.status === 'pending' && a.pageToken != null)
    .filter((a) => opts.includeLive || a.pageTokenExpiresAt == null || a.pageTokenExpiresAt.getTime() <= now.getTime())
    .map((a) => a.id);
}
