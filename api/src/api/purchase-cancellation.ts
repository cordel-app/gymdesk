import type { logger } from '../lib/logger';
import { db, type Tx } from '../infra/db';
import { pendingCancellation, canCancelPending, type PendingAttempt } from '../domain/productSet';
import { PENDING_PURCHASE_STATUS } from '../domain/memberProductPurchase';
import {
  cancelPendingProductSet, reconcileSetPayments, reconcileSubmittedAttempts, type SubmittedAttempt,
} from './product-set-cancellation';
import { deleteProductSetAndOwnPlanSnapshots } from './plan-snapshot-ownership';
import { deletePurchase, updatePurchase } from './purchase-writer';
import { touchPurchases } from './purchases';
import { restorePendingCancellations } from './plan-pending-cancellation';
import { restorePendingReactivations } from './plan-pending-reactivation';
import { restorePendingImmediateCancellations } from './plan-pending-immediate-cancellation';

/**
 * #3355 stage 3 — staff cancel a Purchase (#3251's cart, `purchases`) that awaits its payment,
 * from the Member card's Purchases tab (`⋮ → Cancel`).
 *
 * The Purchase is what is cancelled, so everything it holds that is still `pending_payment` goes
 * with it, through the writers that already own each piece — nothing here is a second lifecycle:
 *
 *  - **It has Billing Events** (its own `billing_events.purchase_id`, its Product Set's events, or
 *    the events its one-time lines are linked to through `billing_event_{oneoff,session}_snapshots`):
 *    the record is kept. Its Product Set is closed by `cancelPendingProductSet()` (#2747: the set,
 *    its events stamped `cancelled_at`, its open attempts expired, its assignment, its linked and
 *    joined one-time Products all `cancelled`; the plans it marked `to_be_canceled` /
 *    `to_be_reactivated` restored, with their previous end dates). A standalone checkout's event is
 *    cancelled exactly as #2480's Billing Event cancel does and its one-time Products move to
 *    `cancelled` (`updatePurchase()`, guarded on `pending_payment`). The cart then reads `cancelled`
 *    (`syncPurchase()`).
 *  - **It has none**: nothing financial exists to keep, so the Product Set is hard-deleted
 *    (`deleteProductSetAndOwnPlanSnapshots()`, a snapshot another set links is never touched), its
 *    one-time Products are hard-deleted (`deletePurchase()`), the owner's marked plans are restored,
 *    and the emptied cart is deleted by `syncPurchase()`.
 *
 * Only what the Purchase itself holds in `pending_payment` moves: a pre-existing plan the checkout
 * merely marked is restored, never deleted or cancelled, and an item in any other state is left as
 * it is. The provider is asked about every submitted attempt first (`reconcilePurchasePayments()`,
 * outside any transaction); then, under the cart's, the set's and the events' row locks,
 * `pendingCancellation()` refuses a settled payment (`payment_settled`) and one whose outcome is
 * unknown or held in flight (`payment_unresolved`). One transaction: nothing is left half
 * cancelled. A repeated cancel answers `already_cancelled` (kept) or `not_found` (deleted).
 */

type Log = typeof logger;

export type CancelPurchaseOutcome =
  | { kind: 'cancelled'; mode: 'kept' | 'deleted' }
  | { kind: 'already_cancelled' }
  | { kind: 'not_found' }
  | { kind: 'not_allowed'; status: string }
  | { kind: 'payment_settled' }
  | { kind: 'payment_unresolved' };

const LINE_TABLES = [
  { table: 'product_session_snapshots', junction: 'billing_event_session_snapshots', col: 'product_session_snapshot_id' },
  { table: 'product_oneoff_snapshots', junction: 'billing_event_oneoff_snapshots', col: 'product_oneoff_snapshot_id' },
] as const;

const marks = (n: number) => Array(n).fill('?').join(',');

/** Every Billing Event the Purchase is associated with (its own, its sets', its lines'). */
async function purchaseEventIds(exec: Pick<Tx, 'query'>, gymId: string, purchaseId: number, lock: boolean): Promise<number[]> {
  const { rows } = await exec.query<{ id: number }>(
    `SELECT be.id FROM billing_events be
      WHERE be.gym_id = ? AND (
        be.purchase_id = ?
        OR be.product_set_id IN (SELECT id FROM product_sets WHERE gym_id = ? AND purchase_id = ?)
        OR be.id IN (SELECT j.billing_event_id FROM billing_event_session_snapshots j
                       JOIN product_session_snapshots s ON s.id = j.product_session_snapshot_id
                      WHERE s.gym_id = ? AND s.purchase_id = ?)
        OR be.id IN (SELECT j.billing_event_id FROM billing_event_oneoff_snapshots j
                       JOIN product_oneoff_snapshots s ON s.id = j.product_oneoff_snapshot_id
                      WHERE s.gym_id = ? AND s.purchase_id = ?))
      ORDER BY be.id${lock ? ' FOR UPDATE' : ''}`,
    [gymId, purchaseId, gymId, purchaseId, gymId, purchaseId, gymId, purchaseId]);
  return rows.map((r) => Number(r.id));
}

/** Asks the provider about every submitted attempt the Purchase is waiting on (before the cancel). */
export async function reconcilePurchasePayments(gymId: string, purchaseId: number, log: Log): Promise<void> {
  const { rows: sets } = await db.query<{ id: number }>(
    `SELECT id FROM product_sets WHERE gym_id = ? AND purchase_id = ? AND status = 'pending_payment'`, [gymId, purchaseId]);
  for (const s of sets) await reconcileSetPayments(gymId, Number(s.id), log);
  const eventIds = await purchaseEventIds(db, gymId, purchaseId, false);
  if (eventIds.length === 0) return;
  const { rows } = await db.query<SubmittedAttempt>(
    `SELECT pr.id, pr.provider_ref, pr.provider_order FROM payment_requests pr
      WHERE pr.gym_id = ? AND pr.transaction_type = 'payment' AND pr.status = 'pending'
        AND pr.provider_ref IS NOT NULL AND pr.billing_event_id IN (${marks(eventIds.length)})`,
    [gymId, ...eventIds]);
  await reconcileSubmittedAttempts(rows, log);
}

/** Cancels the `pending_payment` Purchase `purchaseId`, in the caller's transaction. */
export async function cancelPendingPurchase(
  tx: Tx, gymId: string, purchaseId: number,
  who: { actor: string | null; actorUserId: string | null; source: string },
): Promise<CancelPurchaseOutcome> {
  const { rows: carts } = await tx.query<{ id: number; status: string; owner_member_id: number }>(
    'SELECT id, status, owner_member_id FROM purchases WHERE id = ? AND gym_id = ? FOR UPDATE', [purchaseId, gymId]);
  const cart = carts[0];
  if (!cart) return { kind: 'not_found' };
  if (cart.status === 'cancelled') return { kind: 'already_cancelled' };
  if (cart.status !== 'pending_payment') return { kind: 'not_allowed', status: cart.status };

  const { rows: sets } = await tx.query<{ id: number; status: string; owner_member_id: number; payment_request_id: number | null }>(
    `SELECT id, status, owner_member_id, payment_request_id FROM product_sets
      WHERE gym_id = ? AND purchase_id = ? ORDER BY id FOR UPDATE`, [gymId, purchaseId]);
  const pendingSets = sets.filter((s) => s.status === 'pending_payment');
  const lines: Array<{ table: string; sourceId: number; memberId: number }> = [];
  for (const l of LINE_TABLES) {
    const { rows } = await tx.query<{ source_id: number; member_id: number }>(
      `SELECT source_id, member_id FROM ${l.table}
        WHERE gym_id = ? AND purchase_id = ? AND source_id IS NOT NULL AND status = ? FOR UPDATE`,
      [gymId, purchaseId, PENDING_PURCHASE_STATUS]);
    for (const r of rows) lines.push({ table: l.table, sourceId: Number(r.source_id), memberId: Number(r.member_id) });
  }

  // The events are locked before their attempts are read: a webhook settling one either committed
  // first (its attempt reads `completed`) or waits for us and then finds the event cancelled.
  const eventIds = await purchaseEventIds(tx, gymId, purchaseId, true);
  const owners = new Set(pendingSets.map((s) => Number(s.owner_member_id)));

  if (eventIds.length > 0) {
    const { rows: attempts } = await tx.query<{ provider_ref: string | null; provider_status: string | null; status: string }>(
      `SELECT provider_ref, provider_status, status FROM payment_requests
        WHERE gym_id = ? AND transaction_type = 'payment' AND billing_event_id IN (${marks(eventIds.length)})
          AND billing_event_id IN (SELECT id FROM billing_events WHERE cancelled_at IS NULL)`,
      [gymId, ...eventIds]);
    const decision = pendingCancellation(attempts.map((a): PendingAttempt => ({
      providerRef: a.provider_ref, providerStatus: a.provider_status, status: a.status,
    })));
    if (decision !== 'cancellable') return { kind: decision };

    for (const s of pendingSets) {
      const out = await cancelPendingProductSet(tx, gymId, Number(s.id), who);
      if (out.kind !== 'cancelled' && out.kind !== 'already_cancelled') {
        // Already refused above for the attempts; anything else is a set that moved under us.
        return out.kind === 'not_found' ? { kind: 'not_found' }
          : out.kind === 'not_allowed' ? { kind: 'not_allowed', status: out.status } : { kind: out.kind };
      }
    }
    // The standalone events (a cart checkout's, a staff purchase's): #2480's cancel, in this transaction.
    const open = eventIds.length > 0 ? (await tx.query<{ id: number }>(
      `SELECT id FROM billing_events WHERE gym_id = ? AND cancelled_at IS NULL AND id IN (${marks(eventIds.length)})`,
      [gymId, ...eventIds])).rows.map((r) => Number(r.id)) : [];
    if (open.length > 0) {
      await tx.query(
        `UPDATE payment_requests SET status = 'expired', page_token = NULL, modified_at = UTC_TIMESTAMP(), modified_by = ?
          WHERE gym_id = ? AND transaction_type = 'payment' AND status = 'pending' AND billing_event_id IN (${marks(open.length)})`,
        [who.actor, gymId, ...open]);
      await tx.query(
        `UPDATE billing_events SET cancelled_at = UTC_TIMESTAMP(), cancelled_by = ?, modified_at = UTC_TIMESTAMP(), modified_by = ?
          WHERE gym_id = ? AND cancelled_at IS NULL AND id IN (${marks(open.length)})`,
        [who.actor, who.actor, gymId, ...open]);
    }
    // Its one-time Products still awaiting payment (a set's own moved with the set above).
    for (const l of lines) {
      await updatePurchase(tx, gymId, l.sourceId, { status: 'cancelled' }, who.actor ?? 'System',
        { fromStatus: PENDING_PURCHASE_STATUS });
    }
    await touchPurchases(tx, gymId, [purchaseId]);
    return { kind: 'cancelled', mode: 'kept' };
  }

  // No Billing Event: nothing financial to keep, so what the Purchase added is hard-deleted.
  for (const s of pendingSets) {
    if (s.payment_request_id != null) {
      const { rows } = await tx.query<{ provider_ref: string | null; status: string }>(
        'SELECT provider_ref, status FROM payment_requests WHERE id = ? AND gym_id = ?', [s.payment_request_id, gymId]);
      if (!canCancelPending(rows.map((r) => ({ providerRef: r.provider_ref, providerStatus: null, status: r.status })))) {
        return { kind: 'payment_unresolved' };
      }
    }
  }
  for (const s of pendingSets) {
    if (s.payment_request_id != null) {
      // `product_sets.payment_request_id` is ON DELETE SET NULL.
      await tx.query('DELETE FROM payment_requests WHERE id = ? AND gym_id = ?', [s.payment_request_id, gymId]);
    }
    await deleteProductSetAndOwnPlanSnapshots(tx, gymId, Number(s.id), 'pending_payment');
  }
  for (const l of lines) {
    await deletePurchase(tx, gymId, l.sourceId, { memberId: l.memberId, status: PENDING_PURCHASE_STATUS });
  }
  for (const owner of owners) {
    await restorePendingCancellations(tx, gymId, owner, who.actor);
    await restorePendingReactivations(tx, gymId, owner, who.actor);
    await restorePendingImmediateCancellations(tx, gymId, owner, who.actor);
  }
  await touchPurchases(tx, gymId, [purchaseId]);
  return { kind: 'cancelled', mode: 'deleted' };
}

/** HTTP status and body for a refused outcome; `null` means success. */
export function cancelPurchaseResponse(out: CancelPurchaseOutcome): { status: number; body: Record<string, unknown> } | null {
  switch (out.kind) {
    case 'cancelled':
    case 'already_cancelled':
      return null;
    case 'not_found':
      return { status: 404, body: { error: 'Purchase not found' } };
    case 'not_allowed':
      return { status: 409, body: { error: 'not_pending_payment', status: out.status } };
    case 'payment_settled':
      return { status: 409, body: { error: 'payment_settled', message: 'This purchase has been paid; refund its Billing Event instead.' } };
    case 'payment_unresolved':
      return { status: 409, body: { error: 'payment_unresolved', message: 'A payment for this purchase is still being processed.' } };
  }
}
