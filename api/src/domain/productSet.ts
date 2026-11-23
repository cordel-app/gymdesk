/**
 * #1325 — ProductSet: the versioned commercial configuration of a member.
 *
 * Pure: no database, no clock of its own, no HTTP. `api/src/api/product-sets.ts`
 * is the I/O half and the one writer; this module is the one place that says
 * what the lifecycle is, which transitions are legal and when a Draft has gone
 * stale.
 *
 *   in_cart ──► pending_payment ──► active ──► superseded
 *     │                             ▲
 *     └──── (no payment owed) ──────┘
 *                 │
 *                 └──► cancelled   (#2747: kept, never deleted)
 *
 * - `in_cart`          being prepared (the member's cart; `draft` until #2949 stage 2,
 *                      migration 434); persisted section by section and expires with its
 *                      cart (#3274: `purchases.expires_at`, `domain/cartExpiry.ts`). The
 *                      routes and messages still call it a Draft.
 * - `pending_payment`  committed (Save & Pay); the initial payment is awaited.
 * - `active`           the current committed configuration of the chain.
 * - `superseded`       replaced by a newer version that reached `active`.
 * - `cancelled`        a Pending Payment staff or the member cancelled before it
 *                      was paid (#2747); terminal, kept with its snapshots and
 *                      events for the record, and never activated afterwards.
 *
 * Two uniqueness rules are the database's (`product_sets_one_active`,
 * `product_sets_one_in_flight`); everything else here is the application's.
 */

export const PRODUCT_SET_STATUSES = ['in_cart', 'pending_payment', 'active', 'superseded', 'cancelled'] as const;
export type ProductSetStatus = (typeof PRODUCT_SET_STATUSES)[number];

/** #1991: a Pending Payment that is not confirmed within two hours returns to Draft. */
export const PENDING_TTL_MINUTES = 120;

const TRANSITIONS: Readonly<Record<ProductSetStatus, readonly ProductSetStatus[]>> = {
  in_cart: ['pending_payment', 'active'],
  pending_payment: ['active', 'cancelled'],
  active: ['superseded'],
  superseded: [],
  cancelled: [],
};

/** #2949 stage 2: the status of a Product Set in the member's cart (it was `draft`). */
export const IN_CART_SET_STATUS = 'in_cart';

export function isProductSetStatus(value: unknown): value is ProductSetStatus {
  return typeof value === 'string' && (PRODUCT_SET_STATUSES as readonly string[]).includes(value);
}

export function canTransition(from: ProductSetStatus, to: ProductSetStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Statuses that occupy the owner's single in-flight slot. */
export function isInFlight(status: ProductSetStatus): boolean {
  return status === 'in_cart' || status === 'pending_payment';
}

/** What a cancel of a pending checkout may do, from its payment attempts. */
export interface PendingAttempt {
  /** The provider's own reference; NULL when the provider was never called. */
  providerRef: string | null;
  /** The raw provider status; NULL for a never-submitted or an unknown outcome. */
  providerStatus: string | null;
  /** The internal outcome the row carries today (`pending`/`completed`/`failed`/`expired`). */
  status: string;
}

const TERMINAL_UNSUCCESSFUL = new Set(['FAILED', 'EXPIRED', 'CANCELED']);
const LEGACY_TERMINAL_UNSUCCESSFUL = new Set(['failed', 'expired']);

/**
 * May a Pending Payment set be hard-deleted with these attempts (#1325 §6)?
 *
 * Only when no payment was ever initiated, or every attempt is definitively
 * unsuccessful. An attempt that was submitted (`providerRef` set) with no
 * provider status is an unknown outcome — a timeout — not "not started", and
 * is never deleted until the provider or a reconciliation settles it. A
 * completed attempt is money received and is never deleted here.
 */
export function canCancelPending(attempts: readonly PendingAttempt[]): boolean {
  return attempts.every((a) => {
    if (a.providerStatus !== null) return TERMINAL_UNSUCCESSFUL.has(a.providerStatus);
    if (a.providerRef === null) return a.status !== 'completed';
    return LEGACY_TERMINAL_UNSUCCESSFUL.has(a.status);
  });
}

/** #2747: what cancelling a Pending Payment set may do, from its payment attempts. */
export type PendingCancellation = 'cancellable' | 'payment_settled' | 'payment_unresolved';

/**
 * May a Pending Payment set be cancelled (#2747)? Not when an attempt settled
 * (`completed`: money was received, so the set is the member's or about to be —
 * refunding it is the existing Billing Event refund, a staff decision), and not
 * while an attempt's outcome is unknown or the provider holds it in flight
 * (`AUTHORIZED`, `PENDING_PROCESSING`: money may be captured). An attempt the
 * provider itself reports `PENDING` is a payment the customer never submitted:
 * nothing was captured, so it does not block (the provider's raw status is
 * written onto the attempt by the read-back that precedes the cancel). Every
 * other attempt follows `canCancelPending()`.
 */
export function pendingCancellation(attempts: readonly PendingAttempt[]): PendingCancellation {
  if (attempts.some((a) => a.status === 'completed')) return 'payment_settled';
  const blocking = attempts.filter((a) => (a.providerStatus ?? '').trim().toUpperCase() !== 'PENDING');
  return canCancelPending(blocking) ? 'cancellable' : 'payment_unresolved';
}
