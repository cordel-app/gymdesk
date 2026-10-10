/**
 * #1325 — ProductSet: the versioned commercial configuration of a member.
 *
 * Pure: no database, no clock of its own, no HTTP. `api/src/api/product-sets.ts`
 * is the I/O half and the one writer; this module is the one place that says
 * what the lifecycle is, which transitions are legal and when a Draft has gone
 * stale.
 *
 *   draft ──► pending_payment ──► active ──► superseded
 *     │                             ▲
 *     └──── (no payment owed) ──────┘
 *
 * - `draft`            being prepared; persisted section by section and expires
 *                      after `DRAFT_TTL_MINUTES` without activity.
 * - `pending_payment`  committed (Save & Pay); the initial payment is awaited.
 * - `active`           the current committed configuration of the chain.
 * - `superseded`       replaced by a newer version that reached `active`.
 *
 * Two uniqueness rules are the database's (`product_sets_one_active`,
 * `product_sets_one_in_flight`); everything else here is the application's.
 */

export const PRODUCT_SET_STATUSES = ['draft', 'pending_payment', 'active', 'superseded'] as const;
export type ProductSetStatus = (typeof PRODUCT_SET_STATUSES)[number];

/** A Draft expires after two hours without a successful update (#1325). */
export const DRAFT_TTL_MINUTES = 120;

const TRANSITIONS: Readonly<Record<ProductSetStatus, readonly ProductSetStatus[]>> = {
  draft: ['pending_payment', 'active'],
  pending_payment: ['active'],
  active: ['superseded'],
  superseded: [],
};

export function isProductSetStatus(value: unknown): value is ProductSetStatus {
  return typeof value === 'string' && (PRODUCT_SET_STATUSES as readonly string[]).includes(value);
}

export function canTransition(from: ProductSetStatus, to: ProductSetStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Statuses that occupy the owner's single in-flight slot. */
export function isInFlight(status: ProductSetStatus): boolean {
  return status === 'draft' || status === 'pending_payment';
}

/**
 * Has this Draft gone stale? `lastActivityAt` and `now` are epoch milliseconds
 * so the caller decides the clock — the database's `UTC_TIMESTAMP()` in SQL, a
 * fixed value in a test. Exactly at the limit is still alive: a Draft is
 * expired only once it is *more than* two hours old.
 */
export function isDraftExpired(lastActivityAtMs: number, nowMs: number): boolean {
  return nowMs - lastActivityAtMs > DRAFT_TTL_MINUTES * 60_000;
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
