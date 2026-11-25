import type { Tx } from '../infra/db';
import {
  CANCELS_AT_PERIOD_END_STATUS, PENDING_IMMEDIATE_CANCELLATION_STATUS,
} from '../domain/assignmentStatus';
import { assignmentOfLegacyIdSql } from '../domain/planAssignments';
import { writeAssignmentLifecycle } from './assignment-lifecycle-writer';

/**
 * #3358 stage 1 — Cancel Immediately for a Membership Plan, mirroring #3114's pending reactivation
 * (`plan-pending-reactivation.ts`).
 *
 * A plan cancelling at its period end (`active_cancel_at_period_end`) is marked, in the owner's open
 * In Cart (`markPlanForImmediateCancellation()`), to be cancelled today: its snapshot becomes
 * `to_be_canceled_immediately`, its End Date becomes today and its previous one is remembered
 * (`previous_end_date`). It keeps entitling (now to today) and nothing is cancelled, charged or
 * audited until the cart is committed:
 *
 *   - `restorePendingImmediateCancellations()` runs when the In Cart is discarded, expires or its
 *     checkout is cancelled: every marked plan of the owner goes back to `active_cancel_at_period_end`
 *     with its previous End Date.
 *   - `commitPendingImmediateCancellations()` runs at the head of `activateWithEvents()` — the
 *     transaction of the payment's confirmation (or of a free activation) — and is the one place an
 *     immediate cancellation takes effect and is audited: the plan becomes `cancelled`, its End Date
 *     stays today, `closed_at` is stamped, and the activating set no longer carries it (not even for
 *     entitlement). A failed payment never reaches it.
 *
 * The status lives on the plan's own snapshot and on the assignment's anchor; no snapshot is copied.
 */

export interface PendingImmediateCancellationActor { name: string | null }

export type MarkImmediateCancellationOutcome =
  | { kind: 'ok'; productSetId: number; created: boolean }
  | { kind: 'already_marked' }
  | { kind: 'not_found' }
  | { kind: 'not_cancelling'; status: string }
  | { kind: 'in_flight'; productSetId: number; status: string };

const dateOnly = (v: unknown): string | null =>
  v == null ? null : (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);

/**
 * Marks one plan cancelling at its period end to be cancelled today, inside the owner's open In Cart
 * (opening one when there is none). A plan whose End Date already passed is refused.
 */
export async function markPlanForImmediateCancellation(
  tx: Tx, input: { gymId: string; userMembershipId: number; actor: PendingImmediateCancellationActor; today: string },
): Promise<MarkImmediateCancellationOutcome> {
  const { rows } = await tx.query<{ id: number; member_id: number; status: string; ends_at: Date | string | null }>(
    `SELECT pa.anchor_plan_snapshot_id AS id, pa.member_id, pa.status, pa.ends_at FROM plan_snapshots pa
      WHERE pa.gym_id = ? AND ${assignmentOfLegacyIdSql('?', 'pa')} ORDER BY pa.id DESC LIMIT 1 FOR UPDATE`,
    [input.gymId, input.userMembershipId]);
  const um = rows[0];
  if (!um) return { kind: 'not_found' };
  if (um.status === PENDING_IMMEDIATE_CANCELLATION_STATUS) return { kind: 'already_marked' };
  const endsAt = dateOnly(um.ends_at);
  if (um.status !== CANCELS_AT_PERIOD_END_STATUS || endsAt == null || endsAt < input.today) {
    return { kind: 'not_cancelling', status: um.status };
  }

  const { ensureRecurringDraft } = await import('./recurring-purchase-draft');
  const draft = await ensureRecurringDraft(tx, {
    gymId: input.gymId, memberId: Number(um.member_id), actor: input.actor, today: input.today, staff: true,
  });
  if (draft.kind !== 'ok') return { kind: 'in_flight', productSetId: draft.productSetId, status: draft.status };

  await writeAssignmentLifecycle(tx, input.gymId, input.userMembershipId, {
    status: PENDING_IMMEDIATE_CANCELLATION_STATUS, from: CANCELS_AT_PERIOD_END_STATUS,
    endsAt: { set: input.today }, actor: input.actor.name,
  });
  await tx.query(
    `UPDATE plan_snapshots SET status = ?, previous_end_date = ends_at, ends_at = ?
      WHERE gym_id = ? AND anchor_plan_snapshot_id = ? AND status = ?`,
    [PENDING_IMMEDIATE_CANCELLATION_STATUS, input.today, input.gymId, input.userMembershipId, CANCELS_AT_PERIOD_END_STATUS]);
  return { kind: 'ok', productSetId: draft.productSetId, created: draft.created };
}

/** Puts the marked plans back as they were (all of the owner's, or the one named). */
async function restore(tx: Tx, gymId: string, where: string, params: unknown[], actor: string | null): Promise<number> {
  const { rows } = await tx.query<{ id: number; previous_end_date: Date | string | null }>(
    `SELECT anchor_plan_snapshot_id AS id, MAX(previous_end_date) AS previous_end_date FROM plan_snapshots
      WHERE gym_id = ? AND status = ? AND anchor_plan_snapshot_id IS NOT NULL AND ${where}
      GROUP BY anchor_plan_snapshot_id`,
    [gymId, PENDING_IMMEDIATE_CANCELLATION_STATUS, ...params]);
  for (const r of rows) {
    const previous = dateOnly(r.previous_end_date);
    await writeAssignmentLifecycle(tx, gymId, Number(r.id), {
      status: CANCELS_AT_PERIOD_END_STATUS, from: PENDING_IMMEDIATE_CANCELLATION_STATUS,
      ...(previous != null ? { endsAt: { set: previous } } : {}), actor,
    });
    await tx.query(
      `UPDATE plan_snapshots SET status = ?, ends_at = COALESCE(previous_end_date, ends_at), previous_end_date = NULL
        WHERE gym_id = ? AND anchor_plan_snapshot_id = ? AND status = ?`,
      [CANCELS_AT_PERIOD_END_STATUS, gymId, r.id, PENDING_IMMEDIATE_CANCELLATION_STATUS]);
  }
  return rows.length;
}

/** Un-marks one plan. */
export async function unmarkPlanForImmediateCancellation(
  tx: Tx, input: { gymId: string; userMembershipId: number; actor: PendingImmediateCancellationActor },
): Promise<number> {
  return restore(tx, input.gymId, 'anchor_plan_snapshot_id = ?', [input.userMembershipId], input.actor.name);
}

/** The In Cart carrying the marks was discarded: every marked plan of the owner is restored. */
export async function restorePendingImmediateCancellations(
  tx: Tx, gymId: string, ownerMemberId: number, actor: string | null = null,
): Promise<number> {
  return restore(tx, gymId, 'member_id = ?', [ownerMemberId], actor);
}

/**
 * The In Cart `productSetId` is being activated: each plan its owner marked is cancelled now —
 * `cancelled`, End Date today, `closed_at` stamped — and the activating set stops carrying it.
 * Audited here and only here. Called before the obligations are materialised (nothing is billed for
 * a cancelling plan, so no obligation is removed). Answers how many plans were cancelled.
 */
export async function commitPendingImmediateCancellations(
  tx: Tx, input: { gymId: string; productSetId: number; today: string; actor: string | null },
): Promise<number> {
  const { rows: sets } = await tx.query<{ owner_member_id: number }>(
    'SELECT owner_member_id FROM product_sets WHERE id = ? AND gym_id = ?', [input.productSetId, input.gymId]);
  if (!sets[0]) return 0;
  const ownerId = Number(sets[0].owner_member_id);
  const { rows: marked } = await tx.query<{ id: number }>(
    `SELECT DISTINCT anchor_plan_snapshot_id AS id FROM plan_snapshots
      WHERE gym_id = ? AND member_id = ? AND status = ? AND anchor_plan_snapshot_id IS NOT NULL`,
    [input.gymId, ownerId, PENDING_IMMEDIATE_CANCELLATION_STATUS]);
  if (marked.length === 0) return 0;

  const { recordStatusChange } = await import('./billing-events');
  for (const um of marked) {
    const id = Number(um.id);
    await writeAssignmentLifecycle(tx, input.gymId, id, {
      status: 'cancelled', from: PENDING_IMMEDIATE_CANCELLATION_STATUS,
      endsAt: { set: input.today }, closedAt: 'keep_or_now', actor: input.actor,
    });
    await tx.query(
      `UPDATE plan_snapshots SET status = 'cancelled', ends_at = ?, closed_at = COALESCE(closed_at, UTC_TIMESTAMP()),
              previous_end_date = NULL
        WHERE gym_id = ? AND anchor_plan_snapshot_id = ? AND status = ?`,
      [input.today, input.gymId, id, PENDING_IMMEDIATE_CANCELLATION_STATUS]);
    // A cancelled plan is carried by no set, not even for entitlement (#2659 stage 3).
    await tx.query(
      `DELETE j FROM product_set_plan_snapshots j
         JOIN plan_snapshots s ON s.id = j.plan_snapshot_id
        WHERE j.product_set_id = ? AND j.entitlement_only = 1 AND s.gym_id = ? AND s.anchor_plan_snapshot_id = ?`,
      [input.productSetId, input.gymId, id]);
    await recordStatusChange(tx, {
      gymId: input.gymId, userMembershipId: id, memberId: ownerId,
      previousStatus: CANCELS_AT_PERIOD_END_STATUS, newStatus: 'cancelled', source: 'system', actorUserId: null,
    });
  }
  return marked.length;
}
