import { db, Tx } from '../infra/db';
import { SYSTEM_ACTOR } from '../domain/auditActor';
import {
  DRAFT_TTL_MINUTES,
  PENDING_TTL_MINUTES,
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
      // The Admin's Draft assignment (#1325 PR 3e) expires with its version.
      await tx.query(
        `DELETE um FROM user_memberships um JOIN product_sets ps ON ps.user_membership_id = um.id AND ps.gym_id = um.gym_id
          WHERE ps.id = ? AND um.status = 'draft'`, [inFlight.id]);
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
        membership_plan_id, starts_at, created_by)
     VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
    [input.gymId, input.ownerMemberId, active ? active.root_product_set_id : null,
      active ? active.id : null, version, input.membershipPlanId, input.startsAt,
      input.actor.name],
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
    `UPDATE product_sets SET status = 'pending_payment', payment_request_id = ?, pending_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'draft'`,
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
    // #1991 stage 3: what the predecessor version still has applied is history,
    // Product-target applications included (they have no assignment to carry
    // them). Idempotent: only `applied` rows move, and `revoked` ones stay revoked.
    await tx.query(
      `UPDATE user_membership_promotions
          SET status = 'superseded', modified_at = UTC_TIMESTAMP(), modified_by = ?
        WHERE gym_id = ? AND product_set_id = ? AND status = 'applied'`,
      [SYSTEM_ACTOR, gymId, previous.id],
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
    const { rows: linked } = await tx.query<{ user_membership_id: number | null }>(
      `SELECT user_membership_id FROM product_sets WHERE id = ? AND gym_id = ?`, [id, gymId]);
    await tx.query(`DELETE FROM product_sets WHERE id = ? AND status = 'draft'`, [id]);
    // #1922: a Draft assignment (an Admin-added Membership Plan) is the cache of
    // this version; left behind it would keep showing as a Draft plan on a
    // restored Active set. Only a row still `draft` goes — nothing billed.
    const um = linked[0]?.user_membership_id;
    if (um) await tx.query(`DELETE FROM user_memberships WHERE id = ? AND gym_id = ? AND status = 'draft'`, [um, gymId]);
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
  await tx.query(
    `UPDATE product_sets SET status = 'draft', payment_request_id = NULL, pending_at = NULL, last_activity_at = UTC_TIMESTAMP()
      WHERE id = ? AND status = 'pending_payment'`, [id]);
  await tx.query(
    `UPDATE user_memberships um JOIN product_sets ps ON ps.user_membership_id = um.id AND ps.gym_id = um.gym_id
        SET um.status = 'draft', um.modified_at = UTC_TIMESTAMP(), um.modified_by = ?
      WHERE ps.id = ? AND um.status = 'pending_payment'`, [actor, id]);
  return { kind: 'cancelled' };
}

/**
 * Returns every Pending Payment that was not confirmed in time to Draft: it has
 * been pending for more than `PENDING_TTL_MINUTES`, or the latest attempt on its
 * initial event is `expired` (the payment link is over). A `failed` attempt
 * alone is not expiry (the member may pay again). A payment of unknown outcome
 * or one that settled is left alone by `returnPendingToDraft()`'s own guard.
 */
export async function expirePendingPayments(): Promise<number> {
  const { rows } = await db.query<{ id: number; gym_id: string }>(
    `SELECT ps.id, ps.gym_id FROM product_sets ps
      WHERE ps.status = 'pending_payment'
        AND (COALESCE(ps.pending_at, ps.last_activity_at) < UTC_TIMESTAMP() - INTERVAL ${PENDING_TTL_MINUTES} MINUTE
         OR (SELECT pr.status FROM payment_requests pr JOIN billing_events be ON be.id = pr.billing_event_id
              WHERE be.product_set_id = ps.id ORDER BY pr.created_at DESC, pr.id DESC LIMIT 1) = 'expired')`);
  let n = 0;
  for (const r of rows) {
    const out = await db.transaction((tx) => returnPendingToDraft(tx, r.gym_id, Number(r.id)));
    if (out.kind === 'cancelled') n += 1;
  }
  return n;
}

/**
 * Deletes every Draft that has been idle for more than two hours. One statement,
 * so the status and expiry are re-evaluated by the database at delete time and a
 * set that moved to `pending_payment` between a read and this call survives.
 */
export async function expireDrafts(): Promise<number> {
  // #1325 PR 3e: an Admin Draft assignment expires with its version, so no
  // Draft row is left behind with nothing to edit it.
  await db.query(
    `DELETE um FROM user_memberships um
       JOIN product_sets ps ON ps.user_membership_id = um.id AND ps.gym_id = um.gym_id
      WHERE ps.status = 'draft' AND um.status = 'draft'
        AND ps.last_activity_at < UTC_TIMESTAMP() - INTERVAL ${DRAFT_TTL_MINUTES} MINUTE`,
  );
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
