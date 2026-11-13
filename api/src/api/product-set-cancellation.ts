import type { logger } from '../lib/logger';
import { SYSTEM_ACTOR } from '../domain/auditActor';
import { db, type Tx } from '../infra/db';
import { pendingCancellation, type PendingAttempt } from '../domain/productSet';
import { getPaymentProvider } from '../payments';
import { normaliseProviderStatus } from '../domain/providerPaymentStatus';
import { settleFromProviderLookup } from './payment-settlement';
import { recordStatusChange } from './billing-events';
import { moveSetPurchases } from './set-purchases';
import { syncPlanSnapshot } from './plan-snapshot-sync';

/**
 * #2747 stage 1 — cancelling a Product Set that awaits its first payment.
 *
 * Unlike `returnPendingToDraft()` (#1991 stage 4: an expired or abandoned
 * checkout goes back to the Draft it was saved from, its unpaid event
 * deleted), a cancellation is the member's or staff's decision that the
 * configuration will not be bought, and it is **kept**: the set becomes
 * `cancelled` with its snapshots, its Billing Events are stamped
 * `cancelled_at` (#2480's mechanism, never deleted), its open attempts are
 * closed, the assignment it carried becomes `cancelled` and its one-time
 * purchases `cancelled`. Nothing is physically deleted.
 *
 * Two halves, because the provider must never be called inside a transaction:
 *
 *  1. `reconcileSetPayments()` asks the provider about every attempt that was
 *     submitted and has no outcome yet (#2087's read-back, through the one
 *     settle function). A payment the provider reports as captured is settled,
 *     which activates the set as the webhook would — the cancel then finds it
 *     `active` and refuses; a refusal or an expiry closes the attempt; an
 *     answer with no outcome only records the provider's raw status on it.
 *  2. `cancelPendingProductSet()` decides under the set's and its events' row
 *     locks (`pendingCancellation()`): a settled attempt is `payment_settled`,
 *     an attempt whose outcome is unknown or that the provider holds in flight
 *     (authorized, processing) is `payment_unresolved`, and anything else —
 *     including a payment the provider reports `PENDING`, never submitted — is
 *     cancelled. `provider_status` is never written here — it
 *     stays the provider's own value — and an internal attempt is closed as
 *     `expired`, the status #2480's event cancel already uses.
 *
 * A payment that settles *after* the cancellation (a late webhook) is recorded
 * on its attempt but activates nothing: its event is `cancelled_at`, which
 * `settleInTransaction()` already honours (#2533 stage 2), and `activate()`
 * refuses a `cancelled` set besides. The money is then a collected payment on a
 * cancelled event, refundable through the existing Billing Event refund.
 */

type Log = typeof logger;

export type CancelPendingOutcome =
  | { kind: 'cancelled' }
  | { kind: 'already_cancelled' }
  | { kind: 'not_found' }
  | { kind: 'not_allowed'; status: string }
  | { kind: 'payment_settled' }
  | { kind: 'payment_unresolved' };

/**
 * Asks the provider about the set's submitted, unresolved attempts and settles
 * whatever it answers definitively. Best-effort: a provider that cannot be
 * reached leaves the attempt as it is, and the cancel's own guard refuses.
 */
export async function reconcileSetPayments(gymId: string, productSetId: number, log: Log): Promise<void> {
  const { rows } = await db.query<{ id: number; provider_ref: string; provider_order: string | null }>(
    `SELECT pr.id, pr.provider_ref, pr.provider_order
       FROM payment_requests pr
       JOIN billing_events be ON be.id = pr.billing_event_id AND be.gym_id = pr.gym_id
      WHERE pr.gym_id = ? AND be.product_set_id = ? AND pr.transaction_type = 'payment'
        AND pr.status = 'pending' AND pr.provider_ref IS NOT NULL`,
    [gymId, productSetId]);
  if (rows.length === 0) return;
  let provider;
  try {
    provider = getPaymentProvider();
  } catch (err) {
    log.warn({ productSetId, err: (err as Error).message }, 'Product Set cancel: no payment provider configured, nothing reconciled');
    return;
  }
  for (const row of rows) {
    try {
      const payload = await provider.getPaymentStatus(row.provider_ref);
      if (payload.orderId !== row.provider_order) {
        log.error({ paymentRequestId: row.id }, 'Product Set cancel: provider order id does not match the payment request');
        continue;
      }
      const outcome = await settleFromProviderLookup(payload, { via: 'confirm', log });
      // No final outcome: the provider's own status is still kept on the attempt
      // (verbatim, never mapped to failed), which is what the cancel's guard reads.
      const raw = normaliseProviderStatus(payload.providerStatus ?? null);
      if (outcome.kind === 'intermediate' && raw !== null) {
        await db.query(
          `UPDATE payment_requests SET provider_status = ?, modified_at = UTC_TIMESTAMP(), modified_by = ?
            WHERE id = ? AND status = 'pending'`, [raw, SYSTEM_ACTOR, row.id]);
      }
    } catch (err) {
      log.warn({ paymentRequestId: row.id, err: (err as Error).message }, 'Product Set cancel: provider lookup failed');
    }
  }
}

/** Cancels a `pending_payment` set, in the caller's transaction. Idempotent. */
export async function cancelPendingProductSet(
  tx: Tx, gymId: string, productSetId: number,
  who: { actor: string | null; actorUserId: string | null; source: string },
): Promise<CancelPendingOutcome> {
  const { actor } = who;
  const { rows: sets } = await tx.query<{ id: number; status: string; user_membership_id: number | null }>(
    'SELECT id, status, user_membership_id FROM product_sets WHERE id = ? AND gym_id = ? FOR UPDATE',
    [productSetId, gymId]);
  const set = sets[0];
  if (!set) return { kind: 'not_found' };
  if (set.status === 'cancelled') return { kind: 'already_cancelled' };
  if (set.status !== 'pending_payment') return { kind: 'not_allowed', status: set.status };

  // The events are locked before their attempts are read, so a webhook settling
  // one either committed first (its attempt reads `completed`) or waits for us
  // and then finds the event cancelled.
  const { rows: events } = await tx.query<{ id: number }>(
    'SELECT id FROM billing_events WHERE gym_id = ? AND product_set_id = ? FOR UPDATE', [gymId, productSetId]);
  const eventIds = events.map((e) => Number(e.id));
  const marks = eventIds.map(() => '?').join(',');
  const attempts: PendingAttempt[] = [];
  if (eventIds.length > 0) {
    const { rows } = await tx.query<{ provider_ref: string | null; provider_status: string | null; status: string }>(
      `SELECT provider_ref, provider_status, status FROM payment_requests
        WHERE gym_id = ? AND transaction_type = 'payment' AND billing_event_id IN (${marks})`,
      [gymId, ...eventIds]);
    for (const a of rows) attempts.push({ providerRef: a.provider_ref, providerStatus: a.provider_status, status: a.status });
  }
  const decision = pendingCancellation(attempts);
  if (decision !== 'cancellable') return { kind: decision };

  if (eventIds.length > 0) {
    await tx.query(
      `UPDATE payment_requests SET status = 'expired', page_token = NULL, modified_at = UTC_TIMESTAMP(), modified_by = ?
        WHERE gym_id = ? AND transaction_type = 'payment' AND status = 'pending' AND billing_event_id IN (${marks})`,
      [actor, gymId, ...eventIds]);
    await tx.query(
      `UPDATE billing_events SET cancelled_at = UTC_TIMESTAMP(), cancelled_by = ?, modified_at = UTC_TIMESTAMP(), modified_by = ?
        WHERE gym_id = ? AND cancelled_at IS NULL AND id IN (${marks})`,
      [actor, actor, gymId, ...eventIds]);
  }
  // A Pay-now request the set names directly (no event) closes too.
  await tx.query(
    `UPDATE payment_requests SET status = 'expired', page_token = NULL, modified_at = UTC_TIMESTAMP(), modified_by = ?
      WHERE gym_id = ? AND status = 'pending' AND id = (SELECT payment_request_id FROM product_sets WHERE id = ?)`,
    [actor, gymId, productSetId]);

  await moveSetPurchases(tx, gymId, productSetId, 'pending_payment', 'cancelled');
  await tx.query(
    `UPDATE product_sets SET status = 'cancelled', cancelled_at = UTC_TIMESTAMP(), cancelled_by = ?
      WHERE id = ? AND status = 'pending_payment'`,
    [actor, productSetId]);

  if (set.user_membership_id != null) {
    const { rows: um } = await tx.query<{ id: number; member_id: number; status: string }>(
      'SELECT id, member_id, status FROM user_memberships WHERE id = ? AND gym_id = ? FOR UPDATE',
      [set.user_membership_id, gymId]);
    if (um[0] && um[0].status === 'pending_payment') {
      await tx.query(
        `UPDATE user_memberships SET status = 'cancelled', closed_at = UTC_TIMESTAMP(),
                modified_at = UTC_TIMESTAMP(), modified_by = ?
          WHERE id = ? AND status = 'pending_payment'`,
        [actor, um[0].id]);
      await recordStatusChange(tx, {
        gymId, userMembershipId: Number(um[0].id), memberId: Number(um[0].member_id),
        previousStatus: 'pending_payment', newStatus: 'cancelled', source: who.source, actorUserId: who.actorUserId,
      });
    }
  }
  await syncPlanSnapshot(tx, gymId, productSetId);
  return { kind: 'cancelled' };
}

/** HTTP status and body for a cancel outcome; `null` means success. */
export function cancelPendingResponse(out: CancelPendingOutcome): { status: number; body: Record<string, unknown> } | null {
  switch (out.kind) {
    case 'cancelled':
    case 'already_cancelled':
      return null;
    case 'not_found':
      return { status: 404, body: { error: 'ProductSet not found' } };
    case 'not_allowed':
      return { status: 409, body: { error: 'not_pending_payment', status: out.status } };
    case 'payment_settled':
      return { status: 409, body: { error: 'payment_settled', message: 'This Product Set has been paid; refund its Billing Event instead.' } };
    case 'payment_unresolved':
      return { status: 409, body: { error: 'payment_unresolved', message: 'A payment for this Product Set is still being processed.' } };
  }
}
