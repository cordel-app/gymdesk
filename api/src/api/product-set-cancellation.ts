import { assignmentOfLegacyIdSql, productSetLegacyAssignmentIdSql } from '../domain/planAssignments';
import type { logger } from '../lib/logger';
import { SYSTEM_ACTOR } from '../domain/auditActor';
import { db, type Tx } from '../infra/db';
import { PENDING_EXPIRY_HOURS, pendingCancellation, pendingClockSql, type PendingAttempt } from '../domain/productSet';
import { getPaymentProvider } from '../payments';
import { normaliseProviderStatus } from '../domain/providerPaymentStatus';
import { settleFromProviderLookup } from './payment-settlement';
import { recordStatusChange } from './billing-events';
import { moveSetPurchases, unlinkSetPurchasesFromEvents } from './set-purchases';
import { releaseJoinedCartPurchases } from './cart-checkout';
import { syncPlanSnapshot } from './plan-snapshot-sync';
import { writeAssignmentLifecycle } from './assignment-lifecycle-writer';

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
  const { rows } = await db.query<SubmittedAttempt>(
    `SELECT pr.id, pr.provider_ref, pr.provider_order
       FROM payment_requests pr
       JOIN billing_events be ON be.id = pr.billing_event_id AND be.gym_id = pr.gym_id
      WHERE pr.gym_id = ? AND be.product_set_id = ? AND pr.transaction_type = 'payment'
        AND pr.status = 'pending' AND pr.provider_ref IS NOT NULL`,
    [gymId, productSetId]);
  await reconcileSubmittedAttempts(rows, log);
}

export interface SubmittedAttempt { id: number; provider_ref: string; provider_order: string | null }

/**
 * The provider read-back behind `reconcileSetPayments()`, for any list of submitted, unresolved
 * attempts (#3355 stage 3 asks it of a purchase's standalone Billing Events too). Outside any
 * transaction; best-effort.
 */
export async function reconcileSubmittedAttempts(rows: SubmittedAttempt[], log: Log): Promise<void> {
  if (rows.length === 0) return;
  let provider;
  try {
    provider = getPaymentProvider();
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'Pending payment cancel: no payment provider configured, nothing reconciled');
    return;
  }
  for (const row of rows) {
    try {
      const payload = await provider.getPaymentStatus(row.provider_ref);
      if (payload.orderId !== row.provider_order) {
        log.error({ paymentRequestId: row.id }, 'Pending payment cancel: provider order id does not match the payment request');
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
      log.warn({ paymentRequestId: row.id, err: (err as Error).message }, 'Pending payment cancel: provider lookup failed');
    }
  }
}

/** Cancels a `pending_payment` set, in the caller's transaction. Idempotent. */
export async function cancelPendingProductSet(
  tx: Tx, gymId: string, productSetId: number,
  who: { actor: string | null; actorUserId: string | null; source: string },
  opts: { expire?: boolean } = {},
): Promise<CancelPendingOutcome> {
  const { actor } = who;
  // #3307 stage 3: the 24-hour expiry is this same terminal close, told apart by
  // `billing_events.expired_at` (the event reads *24h expired*). Its pending purchases are
  // `cancelled` like any cancelled checkout's (#3307 stage 7).
  const expire = opts.expire === true;
  const { rows: sets } = await tx.query<{ id: number; status: string; user_membership_id: number | null; owner_member_id: number | null }>(
    `SELECT ps.id, ps.status, ps.owner_member_id, ${productSetLegacyAssignmentIdSql()} AS user_membership_id
       FROM product_sets ps WHERE ps.id = ? AND ps.gym_id = ? FOR UPDATE`,
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
      `UPDATE billing_events SET cancelled_at = UTC_TIMESTAMP(), cancelled_by = ?,
              expired_at = ${expire ? 'UTC_TIMESTAMP()' : 'expired_at'},
              modified_at = UTC_TIMESTAMP(), modified_by = ?
        WHERE gym_id = ? AND cancelled_at IS NULL AND id IN (${marks})`,
      [actor, actor, gymId, ...eventIds]);
  }
  // A Pay-now request the set names directly (no event) closes too.
  await tx.query(
    `UPDATE payment_requests SET status = 'expired', page_token = NULL, modified_at = UTC_TIMESTAMP(), modified_by = ?
      WHERE gym_id = ? AND status = 'pending' AND id = (SELECT payment_request_id FROM product_sets WHERE id = ?)`,
    [actor, gymId, productSetId]);

  await moveSetPurchases(tx, gymId, productSetId, 'pending_payment', 'cancelled');
  // #2949 stage 5: the standalone cart purchases this checkout joined are cancelled with it.
  await releaseJoinedCartPurchases(tx, gymId, productSetId, 'cancelled', actor ?? undefined);
  await tx.query(
    `UPDATE product_sets SET status = 'cancelled', cancelled_at = UTC_TIMESTAMP(), cancelled_by = ?
      WHERE id = ? AND status = 'pending_payment'`,
    [actor, productSetId]);
  // #3251: the cart is kept, cancelled, with its Billing Events.
  const { purchaseOfSet, touchPurchases } = await import('./purchases');
  await touchPurchases(tx, gymId, [await purchaseOfSet(tx, gymId, productSetId)]);

  if (set.user_membership_id != null) {
    // #2125 M6b-48: the assignment's owner is read off its current plan snapshot, never from
    // `user_memberships`; the move is written on the anchor (`writeAssignmentLifecycle()`), guarded
    // on `pending_payment`, which decides whether it moves (it replaces the `FOR UPDATE` read).
    const { rows: um } = await tx.query<{ id: number; member_id: number }>(
      `SELECT pa.anchor_plan_snapshot_id AS id, pa.member_id FROM plan_snapshots pa
        WHERE pa.gym_id = ? AND ${assignmentOfLegacyIdSql('?', 'pa')}`,
      [gymId, set.user_membership_id]);
    const rowCount = um[0]
      ? await writeAssignmentLifecycle(tx, gymId, Number(um[0].id), {
        status: 'cancelled', closedAt: 'now', from: 'pending_payment', actor,
      })
      : 0;
    if (rowCount > 0) {
      await recordStatusChange(tx, {
        gymId, userMembershipId: Number(um[0].id), memberId: Number(um[0].member_id),
        previousStatus: 'pending_payment', newStatus: 'cancelled', source: who.source, actorUserId: who.actorUserId,
      });
    }
  }
  // #3355 stage 3: the plans this checkout marked to be cancelled or reactivated were waiting for its
  // payment, which will now never come: they run on exactly as before (the owner holds one in-flight
  // set, so every mark of the owner is this one's), as a discarded Draft's do.
  if (set.owner_member_id != null) {
    const { restorePendingCancellations } = await import('./plan-pending-cancellation');
    const { restorePendingReactivations } = await import('./plan-pending-reactivation');
    await restorePendingCancellations(tx, gymId, Number(set.owner_member_id), actor);
    await restorePendingReactivations(tx, gymId, Number(set.owner_member_id), actor);
    const { restorePendingImmediateCancellations } = await import('./plan-pending-immediate-cancellation');
    await restorePendingImmediateCancellations(tx, gymId, Number(set.owner_member_id), actor);
  }
  await syncPlanSnapshot(tx, gymId, productSetId);
  return { kind: 'cancelled' };
}

export type ReturnToCartOutcome =
  | { kind: 'returned' }
  | { kind: 'already_in_cart' }
  | { kind: 'not_found' }
  | { kind: 'not_allowed'; status: string }
  | { kind: 'payment_settled' }
  | { kind: 'payment_unresolved' };

/**
 * #3309 — the member cancels the payment of their own Pending Payment Product
 * Set from the Members App: the **payment attempt** ends, the **purchase** does
 * not. In the caller's transaction, under the set's and its events' row locks:
 *
 *  - the same guard as #2747 (`pendingCancellation()`, after the caller's
 *    `reconcileSetPayments()`): a settled attempt is `payment_settled`, one the
 *    provider holds in flight or whose outcome is unknown `payment_unresolved`;
 *  - every open attempt of the set's events (and a Pay-now request the set names)
 *    is closed as `cancelled` — never `expired`, which stays a real timeout — and
 *    keeps its reference, amount and method snapshot; `provider_status` is not
 *    written (#3289);
 *  - the set's initial events are stamped `cancelled_at` (#2480's mechanism), so
 *    they stay in the payment history, take no new attempt, and a late payment on
 *    one is recorded but activates nothing (#2533 stage 2);
 *  - the set returns to `in_cart` with its configuration untouched (plans,
 *    beneficiaries, lines, Promotions), its linked one-time purchases and the
 *    standalone cart purchases its checkout joined go back to the cart (unlinked
 *    from the cancelled event), and its linked assignment back to `in_cart`;
 *  - the next Save & Pay writes a new initial event (`ensureInitialEvent()`
 *    ignores a cancelled one) and a new attempt on it.
 *
 * Idempotent: a set already back in the cart answers `already_in_cart` and
 * changes nothing, so a repeated cancel cannot touch an attempt started after it.
 * Staff cancellation (`POST /product-sets/:id/cancel`) is unchanged (#2747).
 */
export async function returnCancelledCheckoutToCart(
  tx: Tx, gymId: string, productSetId: number, who: { actor: string | null },
): Promise<ReturnToCartOutcome> {
  const { actor } = who;
  const { rows: sets } = await tx.query<{ id: number; status: string; user_membership_id: number | null; purchase_id: number | null }>(
    `SELECT ps.id, ps.status, ps.purchase_id, ${productSetLegacyAssignmentIdSql()} AS user_membership_id
       FROM product_sets ps WHERE ps.id = ? AND ps.gym_id = ? FOR UPDATE`,
    [productSetId, gymId]);
  const set = sets[0];
  if (!set) return { kind: 'not_found' };
  if (set.status === 'in_cart') return { kind: 'already_in_cart' };
  if (set.status !== 'pending_payment') return { kind: 'not_allowed', status: set.status };

  const { rows: events } = await tx.query<{ id: number }>(
    `SELECT id FROM billing_events WHERE gym_id = ? AND product_set_id = ? AND cancelled_at IS NULL FOR UPDATE`,
    [gymId, productSetId]);
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

  // The standalone cart purchases this checkout joined go back to the cart (unlinked from its events).
  await releaseJoinedCartPurchases(tx, gymId, productSetId, 'in_cart', actor ?? undefined);
  if (eventIds.length > 0) {
    await tx.query(
      `UPDATE payment_requests SET status = 'cancelled', page_token = NULL, modified_at = UTC_TIMESTAMP(), modified_by = ?
        WHERE gym_id = ? AND transaction_type = 'payment' AND status = 'pending' AND billing_event_id IN (${marks})`,
      [actor, gymId, ...eventIds]);
    await tx.query(
      `UPDATE billing_events SET cancelled_at = UTC_TIMESTAMP(), cancelled_by = ?, modified_at = UTC_TIMESTAMP(), modified_by = ?
        WHERE gym_id = ? AND cancelled_at IS NULL AND id IN (${marks})`,
      [actor, actor, gymId, ...eventIds]);
    await unlinkSetPurchasesFromEvents(tx, gymId, productSetId, eventIds);
  }
  // A Pay-now request the set names directly (no event) is cancelled too.
  await tx.query(
    `UPDATE payment_requests SET status = 'cancelled', page_token = NULL, modified_at = UTC_TIMESTAMP(), modified_by = ?
      WHERE gym_id = ? AND status = 'pending' AND id = (SELECT payment_request_id FROM product_sets WHERE id = ?)`,
    [actor, gymId, productSetId]);

  await moveSetPurchases(tx, gymId, productSetId, 'pending_payment', 'in_cart');
  await tx.query(
    // #3274: back in the cart, the purchase takes a fresh two hours (`syncPurchase()`'s status move).
    `UPDATE product_sets SET status = 'in_cart', payment_request_id = NULL, pending_at = NULL
      WHERE id = ? AND status = 'pending_payment'`, [productSetId]);
  if (set.user_membership_id != null) {
    await writeAssignmentLifecycle(tx, gymId, Number(set.user_membership_id), { status: 'in_cart', from: 'pending_payment', actor });
  }
  await syncPlanSnapshot(tx, gymId, productSetId);
  const { touchPurchases } = await import('./purchases');
  await touchPurchases(tx, gymId, [set.purchase_id == null ? null : Number(set.purchase_id)]);
  return { kind: 'returned' };
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

/**
 * #3307 stage 3 — a Pending Payment checkout that was not paid within
 * `PENDING_EXPIRY_HOURS` (24) of being saved for payment expires, as a whole:
 * the set's initial Billing Event reads **24h expired** (`expired_at` beside
 * `cancelled_at`), its open attempts close as `expired`, every one-time Product
 * of the checkout still `pending_payment` (linked or joined from the cart)
 * becomes `cancelled` (#3307 stage 7), and the set and its assignment are closed as a
 * cancellation is (`cancelPendingProductSet()`, the one terminal writer). Nothing
 * is deleted; a payment that settles later is recorded on its attempt and
 * activates nothing (#2533 stage 2).
 *
 * The provider is asked first about every submitted attempt
 * (`reconcileSetPayments()`, outside any transaction): a payment it reports
 * captured activates the set instead, and an attempt it still holds in flight
 * or whose outcome is unknown leaves the set pending for the next run. Each set
 * is re-checked under its locks, so a repeated or concurrent run changes nothing
 * twice. Returns how many checkouts expired.
 */
export async function expirePendingPayments(log?: Log): Promise<number> {
  const { rows } = await db.query<{ id: number; gym_id: string }>(
    `SELECT ps.id, ps.gym_id FROM product_sets ps
      WHERE ps.status = 'pending_payment'
        AND ${pendingClockSql('ps')} < UTC_TIMESTAMP() - INTERVAL ${PENDING_EXPIRY_HOURS} HOUR
      ORDER BY ps.id`);
  const lg = log ?? (await import('../lib/logger')).logger;
  let n = 0;
  for (const r of rows) {
    const gymId = r.gym_id;
    const id = Number(r.id);
    await reconcileSetPayments(gymId, id, lg);
    const out = await db.transaction((tx) => cancelPendingProductSet(tx, gymId, id,
      { actor: SYSTEM_ACTOR, actorUserId: null, source: 'system' }, { expire: true }));
    if (out.kind === 'cancelled') n += 1;
  }
  return n;
}
