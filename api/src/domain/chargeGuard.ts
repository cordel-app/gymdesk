/**
 * #1325 PR 2a — the charge guard: refuse a new attempt when an earlier one of
 * the same Billing Event may already have collected the money.
 *
 * The event's *displayed* status is its latest attempt's, with no precedence
 * over earlier ones (decision 3/4). That rule alone would let a delayed
 * SUCCEEDED for attempt 1, arriving after attempt 2 failed, leave the event
 * reading FAILED while the money was received — and the nightly run would then
 * charge it a third time. This guard is the separate duplicate-charge rule: it
 * reads the **raw** provider status of *every* earlier attempt and refuses when
 * any of them settled, is in flight, is an unknown outcome or was refunded.
 * FAILED, EXPIRED and CANCELED do not block a retry.
 *
 * Pure. The caller takes it under the event's row lock so two workers cannot
 * both pass it, and logs a refusal for reconciliation.
 */

import { classifyProviderStatus, normaliseProviderStatus } from './providerPaymentStatus';

export interface EarlierAttempt {
  id: number;
  method: 'provider' | 'cash' | 'waive';
  providerStatus: string | null;
  providerRef: string | null;
  /** The internal outcome the row carries. */
  status: string;
}

export type ChargeGuardDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: 'already_settled' | 'in_flight' | 'unknown_outcome' | 'refunded_requires_review';
      attemptIds: number[];
    };

export function chargeGuard(attempts: readonly EarlierAttempt[]): ChargeGuardDecision {
  const settled: number[] = [];
  const inFlight: number[] = [];
  const unknown: number[] = [];
  const returned: number[] = [];

  for (const a of attempts) {
    if (a.method !== 'provider') {
      // Cash or a waiver that completed settles the obligation outright.
      if (a.status === 'completed') settled.push(a.id);
      continue;
    }
    const cls = classifyProviderStatus(normaliseProviderStatus(a.providerStatus));
    if (cls === 'settled') settled.push(a.id);
    else if (cls === 'in_flight') inFlight.push(a.id);
    else if (cls === 'returned') returned.push(a.id);
    else if (cls === 'unknown') {
      // Never submitted (no provider reference) is "not started"; a submitted
      // attempt with no status is an unknown outcome — a timeout.
      if (a.providerRef !== null || a.status === 'pending') unknown.push(a.id);
    }
  }

  if (settled.length) return { allowed: false, reason: 'already_settled', attemptIds: settled };
  if (inFlight.length) return { allowed: false, reason: 'in_flight', attemptIds: inFlight };
  if (unknown.length) return { allowed: false, reason: 'unknown_outcome', attemptIds: unknown };
  if (returned.length) return { allowed: false, reason: 'refunded_requires_review', attemptIds: returned };
  return { allowed: true };
}
