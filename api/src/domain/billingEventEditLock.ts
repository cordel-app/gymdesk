/**
 * #1325 PR 2a — may a ProductSet be edited, given its past Billing Events?
 *
 * The decision (Q1/B2, confirmed on the ticket): a set must not be modified or
 * replaced while any of its Billing Events has a `billing_date` in the past and
 * is unresolved. Non-blocking: SUCCEEDED, PAID_OUT, REFUNDED, PARTIALLY_REFUNDED
 * and WAIVED. Blocking: FAILED, EXPIRED, CANCELED, PENDING, PENDING_PROCESSING,
 * AUTHORIZED, an attempt with an unknown outcome, and a scheduled event that is
 * past due and was never attempted. Evaluated on the original provider status —
 * never through a generic internal mapping — and a refund is *not* a failure.
 *
 * Pure. It is asked twice: before the edit flow opens, and again server-side at
 * commit so a concurrent payment cannot slip past the first check.
 */

import { ProviderStatusClass, classifyProviderStatus, normaliseProviderStatus } from './providerPaymentStatus';

export interface LatestAttempt {
  /** `provider` attempts carry a provider status; `cash`/`waive` do not. */
  method: 'provider' | 'cash' | 'waive';
  providerStatus: string | null;
  /** The internal outcome (`pending`/`completed`/`failed`/`expired`). */
  status: string;
}

export interface LockEvent {
  id: number;
  /** `YYYY-MM-DD`. */
  billingDate: string | null;
  isScheduled: boolean;
  /** The most recent attempt by `(created_at, id)`, or `null` when none exists. */
  latestAttempt: LatestAttempt | null;
}

export type BlockReason =
  | 'not_attempted'
  | 'unsuccessful'
  | 'in_flight'
  | 'unknown_outcome';

export interface BlockingEvent {
  id: number;
  billingDate: string;
  reason: BlockReason;
  providerStatus: string | null;
}

function reasonFor(event: LockEvent): BlockReason | null {
  const attempt = event.latestAttempt;
  if (attempt === null) {
    // A scheduled obligation past its date that nothing has tried to collect.
    return event.isScheduled ? 'not_attempted' : null;
  }
  // Waive and cash are settled by the method itself: no provider attempt exists.
  if (attempt.method === 'waive') return attempt.status === 'completed' ? null : 'in_flight';
  if (attempt.method === 'cash') return attempt.status === 'completed' ? null : 'in_flight';

  const cls: ProviderStatusClass = classifyProviderStatus(normaliseProviderStatus(attempt.providerStatus));
  switch (cls) {
    case 'settled':
    case 'returned':
      return null;
    case 'in_flight':
      return 'in_flight';
    case 'unsuccessful':
      return 'unsuccessful';
    default:
      return 'unknown_outcome';
  }
}

/** The past-due, unresolved events; an empty list means the set may be edited. */
export function blockingEvents(events: readonly LockEvent[], today: string): BlockingEvent[] {
  const out: BlockingEvent[] = [];
  for (const event of events) {
    if (!event.billingDate || event.billingDate >= today) continue;
    const reason = reasonFor(event);
    if (reason) {
      out.push({
        id: event.id,
        billingDate: event.billingDate,
        reason,
        providerStatus: event.latestAttempt ? normaliseProviderStatus(event.latestAttempt.providerStatus) : null,
      });
    }
  }
  return out;
}

export function isEditLocked(events: readonly LockEvent[], today: string): boolean {
  return blockingEvents(events, today).length > 0;
}
