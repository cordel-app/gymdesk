import { db, Tx } from '../infra/db';
import {
  DRAFT_TTL_MINUTES,
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
  root_product_set_id: number | null;
  previous_product_set_id: number | null;
  version: number;
  status: string;
  membership_plan_id: number | null;
}

const COLUMNS = `id, gym_id, owner_member_id, root_product_set_id, previous_product_set_id,
                 version, status, membership_plan_id`;

const FRESH_DRAFT_SQL = `last_activity_at >= UTC_TIMESTAMP() - INTERVAL ${DRAFT_TTL_MINUTES} MINUTE`;

export interface Actor { name: string | null; type: string | null }

export type CreateDraftOutcome =
  | { kind: 'created'; productSet: ProductSetRow }
  | { kind: 'in_flight'; productSetId: number; status: string };

/** Locks the owner's in-flight (draft / pending_payment) row, if there is one. */
async function lockInFlight(tx: Tx, gymId: string, ownerMemberId: number) {
  const { rows } = await tx.query<ProductSetRow & { expired: number }>(
    `SELECT ${COLUMNS}, NOT (${FRESH_DRAFT_SQL}) AS expired
       FROM product_sets
      WHERE gym_id = ? AND owner_member_id = ? AND status IN ('draft','pending_payment')
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
}): Promise<CreateDraftOutcome> {
  const inFlight = await lockInFlight(tx, input.gymId, input.ownerMemberId);
  if (inFlight) {
    if (inFlight.status === 'draft' && Number(inFlight.expired) === 1) {
      await tx.query(`DELETE FROM product_sets WHERE id = ? AND status = 'draft'`, [inFlight.id]);
    } else {
      return { kind: 'in_flight', productSetId: Number(inFlight.id), status: inFlight.status };
    }
  }

  const active = await lockActive(tx, input.gymId, input.ownerMemberId);
  const version = active ? Number(active.version) + 1 : 1;
  const { insertId } = await tx.query(
    `INSERT INTO product_sets
       (gym_id, owner_member_id, root_product_set_id, previous_product_set_id, version, status,
        membership_plan_id, starts_at, created_by_name, created_by_type)
     VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
    [input.gymId, input.ownerMemberId, active ? active.root_product_set_id : null,
      active ? active.id : null, version, input.membershipPlanId, input.startsAt,
      input.actor.name, input.actor.type],
  );
  if (!active) {
    await tx.query(`UPDATE product_sets SET root_product_set_id = id WHERE id = ?`, [insertId]);
  }
  const { rows } = await tx.query<ProductSetRow>(`SELECT ${COLUMNS} FROM product_sets WHERE id = ?`, [insertId]);
  return { kind: 'created', productSet: rows[0] };
}

/**
 * Records activity on a Draft, extending its two hours. `false` means the Draft
 * is gone or expired — the caller says it is no longer available and the owner
 * starts a new one; nothing is resurrected.
 */
export async function touchDraft(tx: Tx, gymId: string, id: number): Promise<boolean> {
  const { rowCount } = await tx.query(
    `UPDATE product_sets SET last_activity_at = UTC_TIMESTAMP()
      WHERE id = ? AND gym_id = ? AND status = 'draft' AND ${FRESH_DRAFT_SQL}`,
    [id, gymId],
  );
  return rowCount > 0;
}

export type MoveOutcome =
  | { kind: 'ok'; productSet: ProductSetRow }
  | { kind: 'not_found' }
  | { kind: 'expired' }
  | { kind: 'not_allowed'; status: string };

async function lockSet(tx: Tx, gymId: string, id: number) {
  const { rows } = await tx.query<ProductSetRow & { expired: number }>(
    `SELECT ${COLUMNS}, NOT (${FRESH_DRAFT_SQL}) AS expired
       FROM product_sets WHERE id = ? AND gym_id = ? FOR UPDATE`,
    [id, gymId],
  );
  return rows[0] ?? null;
}

/** `draft → pending_payment` — Save & Pay. The Active version is left exactly as it is. */
export async function submitForPayment(tx: Tx, gymId: string, id: number, paymentRequestId: number | null = null): Promise<MoveOutcome> {
  const row = await lockSet(tx, gymId, id);
  if (!row) return { kind: 'not_found' };
  if (row.status !== 'draft') return { kind: 'not_allowed', status: row.status };
  if (Number(row.expired) === 1) return { kind: 'expired' };
  await tx.query(
    `UPDATE product_sets SET status = 'pending_payment', payment_request_id = ? WHERE id = ? AND status = 'draft'`,
    [paymentRequestId, id],
  );
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
  if (row.status !== 'draft' && row.status !== 'pending_payment') return { kind: 'not_allowed', status: row.status };
  if (row.status === 'draft' && Number(row.expired) === 1) return { kind: 'expired' };

  const previous = await lockActive(tx, gymId, Number(row.owner_member_id));
  if (previous) {
    await tx.query(
      `UPDATE product_sets SET status = 'superseded', superseded_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'active'`,
      [previous.id],
    );
  }
  await tx.query(
    `UPDATE product_sets SET status = 'active', activated_at = UTC_TIMESTAMP() WHERE id = ?`,
    [id],
  );
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
  if (row.status === 'draft') {
    await tx.query(`DELETE FROM product_sets WHERE id = ? AND status = 'draft'`, [id]);
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
  await tx.query(`DELETE FROM payment_requests WHERE id IN (
      SELECT payment_request_id FROM product_sets WHERE id = ? AND payment_request_id IS NOT NULL)`, [id]);
  await tx.query(`DELETE FROM product_sets WHERE id = ? AND status = 'pending_payment'`, [id]);
  return { kind: 'cancelled' };
}

/**
 * Deletes every Draft that has been idle for more than two hours. One statement,
 * so the status and expiry are re-evaluated by the database at delete time and a
 * set that moved to `pending_payment` between a read and this call survives.
 */
export async function expireDrafts(): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM product_sets
      WHERE status = 'draft'
        AND last_activity_at < UTC_TIMESTAMP() - INTERVAL ${DRAFT_TTL_MINUTES} MINUTE`,
  );
  return rowCount;
}

/** Covers a member by the chain — never by a copy of a ProductSet (#1325 B1). */
export async function addCoverage(tx: Tx, input: {
  gymId: string; rootProductSetId: number; memberId: number; isOwner: boolean;
}): Promise<void> {
  await tx.query(
    `INSERT IGNORE INTO product_set_members (gym_id, root_product_set_id, member_id, is_owner)
     VALUES (?, ?, ?, ?)`,
    [input.gymId, input.rootProductSetId, input.memberId, input.isOwner ? 1 : 0],
  );
}
