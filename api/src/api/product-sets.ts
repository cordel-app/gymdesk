import { writeAssignmentLifecycle } from './assignment-lifecycle-writer';
import { db, Tx } from '../infra/db';
import { restorePendingCancellations } from './plan-pending-cancellation';
import { restorePendingReactivations } from './plan-pending-reactivation';
import { SYSTEM_ACTOR } from '../domain/auditActor';
import { productSetLegacyAssignmentIdSql } from '../domain/planAssignments';
import { syncPlanSnapshot } from './plan-snapshot-sync';
import { primaryPlanSnapshotId } from './plan-snapshot-lines';
import { deleteProductSetAndOwnPlanSnapshots, discardDraftSet } from './plan-snapshot-ownership';
import { activateSetPurchases, moveSetPurchases } from './set-purchases';
import { deleteStandaloneCartPurchases } from './cart-checkout';
import { openCart, refreshCart, touchPurchases } from './purchases';
import { setCartExpiredSql, setCartLiveSql } from '../domain/cartExpiry';
import {
  PendingAttempt,
  canCancelPending,
} from '../domain/productSet';

/**
 * #1325 — the one writer of `product_sets`.
 *
 * Every lifecycle move runs here, under the owner's row lock, so a concurrent
 * commit, edit or cleanup can neither leave two Active versions nor strand the
 * owner behind a stale Draft. The two UNIQUE generated columns of migration 246
 * are the backstop; this module is the rule. `domain/productSet.ts` decides what
 * a transition *is*; this decides when it happens.
 *
 * Nothing here deletes an Active or Superseded set, and nothing here touches a
 * Billing Event: event replacement arrives with persisted events (PR 2).
 */

export interface ProductSetRow {
  id: number;
  gym_id: string;
  owner_member_id: number;
  previous_product_set_id: number | null;
  status: string;
  membership_plan_id: number | null;
  /** #3251: the cart (`purchases`) the version belongs to; NULL for one no checkout made. */
  purchase_id?: number | null;
}

const COLUMNS = `id, gym_id, owner_member_id, previous_product_set_id,
                 status, membership_plan_id, purchase_id`;


/**
 * Who is acting. Only `name` is written (#1182 stage 3: `created_by` is the
 * plain-text snapshot `resolveRequestActor()` produced); `type` is no longer
 * stored and is kept on the shape only so the existing callers still compile.
 */
export interface Actor { name: string | null; type?: string | null }

export type CreateDraftOutcome =
  | { kind: 'created'; productSet: ProductSetRow }
  | { kind: 'in_flight'; productSetId: number; status: string };

/** Locks the owner's in-flight (draft / pending_payment) row, if there is one. */
async function lockInFlight(tx: Tx, gymId: string, ownerMemberId: number) {
  const { rows } = await tx.query<ProductSetRow & { expired: number }>(
    `SELECT ${COLUMNS}, ${setCartExpiredSql('product_sets')} AS expired
       FROM product_sets
      WHERE gym_id = ? AND owner_member_id = ? AND status IN ('in_cart','pending_payment')
      FOR UPDATE`,
    [gymId, ownerMemberId],
  );
  return rows[0] ?? null;
}

async function lockActive(tx: Tx, gymId: string, ownerMemberId: number) {
  const { rows } = await tx.query<ProductSetRow>(
    `SELECT ${COLUMNS} FROM product_sets
      WHERE gym_id = ? AND owner_member_id = ? AND status = 'active' FOR UPDATE`,
    [gymId, ownerMemberId],
  );
  return rows[0] ?? null;
}

/**
 * Starts a Draft — the next version of the owner's chain, or v1 of a new one.
 * The Active version is not touched (§2: opening an editor supersedes nothing).
 * An expired Draft in the owner's in-flight slot is deleted first; a live Draft
 * or a Pending Payment set answers `in_flight` instead of creating another.
 */
export async function createDraft(tx: Tx, input: {
  gymId: string; ownerMemberId: number; membershipPlanId: number | null;
  startsAt: string; actor: Actor;
  /**
   * #3251: whether the Draft is a cart (the default). The bridge's versions, which edit or retire a
   * running plan and are activated in the same transaction, are not checkouts and pass `false`.
   */
  purchase?: boolean;
}): Promise<CreateDraftOutcome> {
  const inFlight = await lockInFlight(tx, input.gymId, input.ownerMemberId);
  if (inFlight) {
    if (inFlight.status === 'in_cart' && Number(inFlight.expired) === 1 && inFlight.purchase_id != null) {
      // #3274: the Draft's cart is past its time, so the whole cart expires (the Admin's Draft
      // assignment, #1325 PR 3e, with its version) and the owner starts a new one.
      const { expireCartInTx } = await import('./cart-expiry');
      await expireCartInTx(tx, input.gymId, Number(inFlight.purchase_id));
    } else {
      return { kind: 'in_flight', productSetId: Number(inFlight.id), status: inFlight.status };
    }
  }

  const active = await lockActive(tx, input.gymId, input.ownerMemberId);
  const purchaseId = input.purchase === false ? null
    : await openCart(tx, input.gymId, input.ownerMemberId, input.actor.name);
  const { insertId } = await tx.query(
    `INSERT INTO product_sets
       (gym_id, owner_member_id, previous_product_set_id, status,
        membership_plan_id, starts_at, created_by, purchase_id)
     VALUES (?, ?, ?, 'in_cart', ?, ?, ?, ?)`,
    [input.gymId, input.ownerMemberId,
      active ? active.id : null, input.membershipPlanId, input.startsAt,
      input.actor.name, purchaseId],
  );
  await touchPurchases(tx, input.gymId, [purchaseId]);
  const { rows } = await tx.query<ProductSetRow>(`SELECT ${COLUMNS} FROM product_sets WHERE id = ?`, [insertId]);
  return { kind: 'created', productSet: rows[0] };
}

/**
 * Records activity on a Draft: #3274, its cart's one clock (`purchases.expires_at`) moves two hours
 * ahead. `false` means the Draft is gone or its cart expired — the caller says it is no longer
 * available and the owner starts a new one; nothing is resurrected.
 */
export async function touchDraft(tx: Tx, gymId: string, id: number): Promise<boolean> {
  const { rows } = await tx.query<{ purchase_id: number | null }>(
    `SELECT purchase_id FROM product_sets WHERE id = ? AND gym_id = ? AND ${setCartLiveSql('product_sets')}`,
    [id, gymId],
  );
  if (!rows[0]) return false;
  return refreshCart(tx, gymId, rows[0].purchase_id);
}

export type MoveOutcome =
  | { kind: 'ok'; productSet: ProductSetRow }
  | { kind: 'not_found' }
  | { kind: 'expired' }
  | { kind: 'not_allowed'; status: string };

export async function lockSet(tx: Tx, gymId: string, id: number) {
  const { rows } = await tx.query<ProductSetRow & { expired: number }>(
    `SELECT ${COLUMNS}, ${setCartExpiredSql('product_sets')} AS expired
       FROM product_sets WHERE id = ? AND gym_id = ? FOR UPDATE`,
    [id, gymId],
  );
  return rows[0] ?? null;
}

/** `draft → pending_payment` — Save & Pay. The Active version is left exactly as it is. */
export async function submitForPayment(tx: Tx, gymId: string, id: number, paymentRequestId: number | null = null): Promise<MoveOutcome> {
  const row = await lockSet(tx, gymId, id);
  if (!row) return { kind: 'not_found' };
  if (row.status !== 'in_cart') return { kind: 'not_allowed', status: row.status };
  if (Number(row.expired) === 1) return { kind: 'expired' };
  // #2624 stage 4: the Promotions applied while it was a Draft are captured now.
  const { confirmDraftPromotionSnapshots } = await import('./membership-promotions');
  await confirmDraftPromotionSnapshots(tx, gymId, id);
  // #2657 stage 3: a committed plan holds its Individual Products one line per member.
  const { syncPlanLineAllocations } = await import('./plan-line-allocation');
  await syncPlanLineAllocations(tx, gymId, id, { split: true });
  // #2746: the one-time Products in the cart move with it.
  await moveSetPurchases(tx, gymId, id, 'in_cart', 'pending_payment');
  await tx.query(
    `UPDATE product_sets SET status = 'pending_payment', payment_request_id = ?, pending_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'in_cart'`,
    [paymentRequestId, id],
  );
  await syncPlanSnapshot(tx, gymId, id);
  await touchPurchases(tx, gymId, [row.purchase_id]);
  return { kind: 'ok', productSet: { ...row, status: 'pending_payment' } };
}

/**
 * `draft | pending_payment → active`: the replacement becomes the current
 * version and the previous Active one is superseded, in one transaction. The
 * call is idempotent: activating a set that is already `active` is `ok` and
 * changes nothing (a duplicate webhook).
 */
export async function activate(tx: Tx, gymId: string, id: number): Promise<MoveOutcome> {
  const row = await lockSet(tx, gymId, id);
  if (!row) return { kind: 'not_found' };
  if (row.status === 'active') return { kind: 'ok', productSet: row };
  if (row.status !== 'in_cart' && row.status !== 'pending_payment') return { kind: 'not_allowed', status: row.status };
  if (row.status === 'in_cart' && Number(row.expired) === 1) return { kind: 'expired' };
  if (row.status === 'in_cart') {
    // #2624 stage 4: a free commit confirms the Draft's Promotion snapshots too.
    const { confirmDraftPromotionSnapshots } = await import('./membership-promotions');
    await confirmDraftPromotionSnapshots(tx, gymId, id);
    // #2657 stage 3: and splits its Individual Products into one line per member.
    const { syncPlanLineAllocations } = await import('./plan-line-allocation');
    await syncPlanLineAllocations(tx, gymId, id, { split: true });
  }

  const previous = await lockActive(tx, gymId, Number(row.owner_member_id));
  if (previous) {
    await tx.query(
      `UPDATE product_sets SET status = 'superseded', superseded_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'active'`,
      [previous.id],
    );
    // #1991 stage 3: what the predecessor version still has applied is history,
    // Product-target applications included (they have no assignment to carry
    // them). Idempotent: only `applied` rows move, and `revoked` ones stay revoked.
    // #3026 stage 3d-3c: a line-owned one on its Product snapshot row (the only kind since 3d-3d).
    const { supersedeProductPromotionsOfSet } = await import('./product-promotion-writer');
    await supersedeProductPromotionsOfSet(tx, gymId, Number(previous.id), SYSTEM_ACTOR);
    // #3026 stage 3c-3: and on the plan snapshots only the predecessor links.
    const { supersedePlanPromotionsOfSet } = await import('./plan-promotion-writer');
    await supersedePlanPromotionsOfSet(tx, gymId, Number(previous.id), SYSTEM_ACTOR);
  }
  await tx.query(
    `UPDATE product_sets SET status = 'active', activated_at = UTC_TIMESTAMP() WHERE id = ?`,
    [id],
  );
  // #2746: and become the member's with it (a duplicate activation returned above, so this runs once).
  await activateSetPurchases(tx, gymId, id);
  // M6b-6: the superseded set first, so its own snapshots state how their plans ended before the new
  // Active set looks for an ended plan no snapshot states (`carryClosedAssignments()`).
  if (previous) await syncPlanSnapshot(tx, gymId, Number(previous.id));
  await syncPlanSnapshot(tx, gymId, id);
  await touchPurchases(tx, gymId, [row.purchase_id]);
  return { kind: 'ok', productSet: { ...row, status: 'active' } };
}

export type CancelOutcome =
  | { kind: 'cancelled' }
  | { kind: 'not_found' }
  | { kind: 'not_allowed'; status: string }
  | { kind: 'unresolved' };

/**
 * Cancels the owner's in-flight checkout by deleting the set (§5/§6): a Draft
 * always, a Pending Payment only while `canCancelPending()` says no payment is
 * in flight or settled. The Active and every Superseded set are untouched.
 */
export async function cancelInFlight(tx: Tx, gymId: string, id: number): Promise<CancelOutcome> {
  const row = await lockSet(tx, gymId, id);
  if (!row) return { kind: 'not_found' };
  if (row.status === 'in_cart') {
    // #1922 / #2125 M6b-51d-7c-1: a Draft assignment (an Admin-added Membership Plan) is this
    // version's plan snapshot, so discarding the version discards the assignment; nothing else to delete.
    await discardDraftSet(tx, gymId, id);
    // #3007: the plans the discarded Draft marked as pending cancellation run on as they were.
    await restorePendingCancellations(tx, gymId, Number(row.owner_member_id));
    await restorePendingReactivations(tx, gymId, Number(row.owner_member_id));
    // #2967: Cancel is the whole cart, so the owner's standalone In Cart purchases go with it.
    await deleteStandaloneCartPurchases(tx, gymId, Number(row.owner_member_id));
    return { kind: 'cancelled' };
  }
  if (row.status !== 'pending_payment') return { kind: 'not_allowed', status: row.status };

  const { rows } = await tx.query<{ provider_ref: string | null; status: string }>(
    `SELECT pr.provider_ref, pr.status
       FROM payment_requests pr
       JOIN product_sets ps ON ps.payment_request_id = pr.id
      WHERE ps.id = ? AND ps.gym_id = ?`,
    [id, gymId],
  );
  const attempts: PendingAttempt[] = rows.map((r) => ({
    providerRef: r.provider_ref, providerStatus: null, status: r.status,
  }));
  if (!canCancelPending(attempts)) return { kind: 'unresolved' };
  // #2949 stage 5: deleting the checkout returns the standalone cart purchases it joined to the cart.
  const { releaseJoinedCartPurchases } = await import('./cart-checkout');
  await releaseJoinedCartPurchases(tx, gymId, id, 'in_cart');
  await tx.query(`DELETE FROM payment_requests WHERE id IN (
      SELECT payment_request_id FROM product_sets WHERE id = ? AND payment_request_id IS NOT NULL)`, [id]);
  await deleteProductSetAndOwnPlanSnapshots(tx, gymId, id, 'pending_payment');
  return { kind: 'cancelled' };
}

/**
 * #1991 stage 4: `pending_payment → draft`. A checkout that was cancelled or
 * whose payment link expired returns to the Draft it was saved from: the
 * configuration (plan snapshot, lines, applications, coverage) is untouched,
 * the unpaid initial event and its attempts are deleted, and the linked
 * assignment goes back to `draft` with it. Applications have no pending state
 * of their own — they stay `applied` and are a Draft's again by the version.
 * Refused (`unresolved`) unless `canCancelPending()` says every attempt is
 * definitively unsuccessful or none was submitted; the events are locked first,
 * so a webhook confirming a payment either settles before this reads (and the
 * attempt is `completed`) or waits for it and finds the set a Draft.
 */
export async function returnPendingToDraft(tx: Tx, gymId: string, id: number, actor = SYSTEM_ACTOR): Promise<CancelOutcome> {
  const row = await lockSet(tx, gymId, id);
  if (!row) return { kind: 'not_found' };
  if (row.status !== 'pending_payment') return { kind: 'not_allowed', status: row.status };

  const { rows: events } = await tx.query<{ id: number }>(
    `SELECT id FROM billing_events WHERE gym_id = ? AND product_set_id = ? FOR UPDATE`, [gymId, id]);
  const { rows: attempts } = await tx.query<{ provider_ref: string | null; provider_status: string | null; status: string }>(
    `SELECT provider_ref, provider_status, status FROM payment_requests
      WHERE gym_id = ? AND billing_event_id IN (SELECT id FROM billing_events WHERE product_set_id = ?)`,
    [gymId, id]);
  if (!canCancelPending(attempts.map((a) => ({
    providerRef: a.provider_ref, providerStatus: a.provider_status, status: a.status,
  })))) return { kind: 'unresolved' };

  // #2949 stage 5: the standalone cart purchases this checkout joined go back to the cart (before the
  // events that link them are deleted).
  const { releaseJoinedCartPurchases } = await import('./cart-checkout');
  await releaseJoinedCartPurchases(tx, gymId, id, 'in_cart', actor);
  if (events.length > 0) {
    const ids = events.map((e) => e.id);
    const marks = ids.map(() => '?').join(',');
    await tx.query(`DELETE FROM payment_requests WHERE gym_id = ? AND billing_event_id IN (${marks})`, [gymId, ...ids]);
    await tx.query(`DELETE FROM billing_events WHERE gym_id = ? AND id IN (${marks})`, [gymId, ...ids]);
  }
  // The request the set names (a Pay-now link that carries no event) goes too.
  await tx.query(
    `DELETE FROM payment_requests WHERE gym_id = ? AND id IN (
       SELECT payment_request_id FROM (SELECT payment_request_id FROM product_sets WHERE id = ? AND payment_request_id IS NOT NULL) x)
      AND status <> 'completed'`, [gymId, id]);
  await moveSetPurchases(tx, gymId, id, 'pending_payment', 'in_cart');
  await tx.query(
    // #3274: back in the cart, the purchase takes a fresh two hours (`syncPurchase()`'s status move).
    `UPDATE product_sets SET status = 'in_cart', payment_request_id = NULL, pending_at = NULL
      WHERE id = ? AND status = 'pending_payment'`, [id]);
  const { rows: linked } = await tx.query<{ um_id: number | null }>(
    `SELECT ${productSetLegacyAssignmentIdSql()} AS um_id FROM product_sets ps WHERE ps.id = ? AND ps.gym_id = ?`, [id, gymId]);
  if (linked[0]?.um_id != null) {
    await writeAssignmentLifecycle(tx, gymId, Number(linked[0].um_id), { status: 'in_cart', from: 'pending_payment', actor });
  }
  await syncPlanSnapshot(tx, gymId, id);
  await touchPurchases(tx, gymId, [row.purchase_id]);
  return { kind: 'cancelled' };
}

/** Covers a member on one plan snapshot of a version (#2125 stage 21): the version's primary one by default. */
export async function addCoverage(tx: Tx, input: {
  gymId: string; productSetId: number; memberId: number; isOwner: boolean; planSnapshotId?: number;
}): Promise<void> {
  const snapshotId = input.planSnapshotId ?? await primaryPlanSnapshotId(tx, input.gymId, input.productSetId);
  if (snapshotId == null) return;
  await tx.query(
    `INSERT INTO plan_snapshot_beneficiaries (gym_id, plan_snapshot_id, member_id, is_owner)
     VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE is_owner = GREATEST(is_owner, VALUES(is_owner))`,
    [input.gymId, snapshotId, input.memberId, input.isOwner ? 1 : 0],
  );
}
