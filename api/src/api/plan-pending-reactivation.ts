import type { Tx } from '../infra/db';
import {
  CANCELS_AT_PERIOD_END_STATUS, PENDING_CANCELLATION_STATUS, PENDING_REACTIVATION_STATUS,
} from '../domain/assignmentStatus';
import { assignmentOfLegacyIdSql } from '../domain/planAssignments';
import { unmarkPlanForCancellation } from './plan-pending-cancellation';
import { linkProductSetToAssignment } from './plan-assignment-sync';
import { productSetAssignmentSql } from '../domain/planAssignments';
import { writeAssignmentLifecycle } from './assignment-lifecycle-writer';

/**
 * #3114 — the pending-reactivation lifecycle of a Membership Plan, mirroring #3007's pending
 * cancellation (`plan-pending-cancellation.ts`).
 *
 * A plan cancelling at its period end (`active_cancel_at_period_end`) is marked for reactivation in
 * the member's open In Cart (`markPlanForReactivation()`): its snapshot becomes `to_be_reactivated`
 * and remembers its `ends_at` (`previous_end_date`). The mark changes nothing else — the plan keeps
 * its end date, its entitlement and its entitlement-only link, no Billing Event is generated, nothing
 * is audited. Then:
 *
 *   - `restorePendingReactivations()` runs when the In Cart is discarded or expires: every marked plan
 *     of the owner goes back to `active_cancel_at_period_end`, `ends_at` untouched.
 *   - `commitPendingReactivations()` runs at the head of `activateWithEvents()` — the transaction of the
 *     payment's confirmation (or of a free activation) — so it is the one place a reactivation takes
 *     effect and the one place it is audited: the same plan (no new assignment) becomes `active`, its
 *     end and closure dates are cleared, and its link in the activating set becomes a billable one, so
 *     `materialiseScheduledEvents()` generates its scheduled obligations (the periods already paid
 *     through `ends_at` exist and are never generated again: `UNIQUE (schedule_id, period_start)`).
 *     A failed payment never reaches it, so nothing is audited for it.
 *
 * A plan marked `to_be_canceled` is a different case: reactivating it just undoes the pending
 * cancellation (`unmarkPlanForCancellation()`), with no billing and no reactivation audit.
 *
 * The status lives on the plan's own snapshot and on the assignment's anchor (the
 * one `setLegacyStatus()` call, as in `plan-pending-cancellation.ts`); no snapshot is copied.
 */

export interface PendingReactivationActor { name: string | null }

export type MarkReactivationOutcome =
  | { kind: 'ok'; productSetId: number; created: boolean }
  | { kind: 'cancellation_undone' }
  | { kind: 'already_marked' }
  | { kind: 'not_found' }
  | { kind: 'not_reactivatable'; status: string }
  | { kind: 'in_flight'; productSetId: number; status: string };

const dateOnly = (v: unknown): string | null =>
  v == null ? null : (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);

/** The dual-write: the legacy row follows the snapshot, guarded on the status it moves away from. */
async function setLegacy(
  tx: Tx, gymId: string, id: number, from: string, to: string, actor: string | null, clearEnd: boolean,
) {
  await writeAssignmentLifecycle(tx, gymId, id, {
    status: to, from, actor, ...(clearEnd ? { endsAt: 'clear' as const, closedAt: 'clear' as const } : {}),
  });
}

/**
 * Marks one plan for reactivation, inside the owner's open In Cart (opening one when there is none).
 * A plan with a cancellation pending (`to_be_canceled`) simply has it undone.
 */
export async function markPlanForReactivation(
  tx: Tx, input: { gymId: string; userMembershipId: number; actor: PendingReactivationActor; today: string },
): Promise<MarkReactivationOutcome> {
  const { rows } = await tx.query<{ id: number; member_id: number; status: string; ends_at: Date | string | null }>(
    `SELECT pa.anchor_plan_snapshot_id AS id, pa.member_id, pa.status, pa.ends_at FROM plan_snapshots pa
      WHERE pa.gym_id = ? AND ${assignmentOfLegacyIdSql('?', 'pa')} ORDER BY pa.id DESC LIMIT 1 FOR UPDATE`,
    [input.gymId, input.userMembershipId]);
  const um = rows[0];
  if (!um) return { kind: 'not_found' };
  if (um.status === PENDING_REACTIVATION_STATUS) return { kind: 'already_marked' };
  if (um.status === PENDING_CANCELLATION_STATUS) {
    // Not a reactivation: the pending cancellation is reversed, with no billing and no audit of one.
    await unmarkPlanForCancellation(tx, { gymId: input.gymId, userMembershipId: input.userMembershipId, actor: input.actor });
    return { kind: 'cancellation_undone' };
  }
  const endsAt = dateOnly(um.ends_at);
  if (um.status !== CANCELS_AT_PERIOD_END_STATUS || endsAt == null || endsAt < input.today) {
    return { kind: 'not_reactivatable', status: um.status };
  }

  const { ensureRecurringDraft } = await import('./recurring-purchase-draft');
  const draft = await ensureRecurringDraft(tx, {
    gymId: input.gymId, memberId: Number(um.member_id), actor: input.actor, today: input.today, staff: true,
  });
  if (draft.kind !== 'ok') return { kind: 'in_flight', productSetId: draft.productSetId, status: draft.status };

  await setLegacy(tx, input.gymId, input.userMembershipId, CANCELS_AT_PERIOD_END_STATUS, PENDING_REACTIVATION_STATUS, input.actor.name, false);
  await tx.query(
    `UPDATE plan_snapshots SET status = ?, previous_end_date = ends_at
      WHERE gym_id = ? AND anchor_plan_snapshot_id = ? AND status = ?`,
    [PENDING_REACTIVATION_STATUS, input.gymId, input.userMembershipId, CANCELS_AT_PERIOD_END_STATUS]);
  return { kind: 'ok', productSetId: draft.productSetId, created: draft.created };
}

/** Puts the marked plans back as they were (all of the owner's, or the one named). */
async function restore(tx: Tx, gymId: string, where: string, params: unknown[], actor: string | null): Promise<number> {
  const { rows } = await tx.query<{ id: number }>(
    `SELECT DISTINCT anchor_plan_snapshot_id AS id FROM plan_snapshots
      WHERE gym_id = ? AND status = ? AND anchor_plan_snapshot_id IS NOT NULL AND ${where}`,
    [gymId, PENDING_REACTIVATION_STATUS, ...params]);
  for (const r of rows) {
    await setLegacy(tx, gymId, Number(r.id), PENDING_REACTIVATION_STATUS, CANCELS_AT_PERIOD_END_STATUS, actor, false);
    await tx.query(
      `UPDATE plan_snapshots SET status = ?, ends_at = COALESCE(previous_end_date, ends_at), previous_end_date = NULL
        WHERE gym_id = ? AND anchor_plan_snapshot_id = ? AND status = ?`,
      [CANCELS_AT_PERIOD_END_STATUS, gymId, r.id, PENDING_REACTIVATION_STATUS]);
  }
  return rows.length;
}

/** Un-marks one plan. */
export async function unmarkPlanForReactivation(
  tx: Tx, input: { gymId: string; userMembershipId: number; actor: PendingReactivationActor },
): Promise<number> {
  return restore(tx, input.gymId, 'anchor_plan_snapshot_id = ?', [input.userMembershipId], input.actor.name);
}

/** The In Cart carrying the marks was discarded: every marked plan of the owner is restored. */
export async function restorePendingReactivations(
  tx: Tx, gymId: string, ownerMemberId: number, actor: string | null = null,
): Promise<number> {
  return restore(tx, gymId, 'member_id = ?', [ownerMemberId], actor);
}

/**
 * The In Cart `productSetId` is being activated (the payment is confirmed, or nothing is owed): each
 * plan its owner marked is reactivated now — `active` again, end and closure dates cleared — and
 * becomes one of the activating set's billable plans, so the activation generates its obligations.
 * Audited here and only here (a status change inside this transaction). Called before the
 * obligations are materialised. Answers how many plans were reactivated.
 */
export async function commitPendingReactivations(
  tx: Tx, input: { gymId: string; productSetId: number; actor: string | null },
): Promise<number> {
  const { rows: sets } = await tx.query<{ owner_member_id: number }>(
    'SELECT owner_member_id FROM product_sets WHERE id = ? AND gym_id = ?', [input.productSetId, input.gymId]);
  if (!sets[0]) return 0;
  const ownerId = Number(sets[0].owner_member_id);
  const { rows: marked } = await tx.query<{ id: number }>(
    `SELECT DISTINCT anchor_plan_snapshot_id AS id FROM plan_snapshots
      WHERE gym_id = ? AND member_id = ? AND status = ? AND anchor_plan_snapshot_id IS NOT NULL`,
    [input.gymId, ownerId, PENDING_REACTIVATION_STATUS]);
  if (marked.length === 0) return 0;

  const { recordStatusChange } = await import('./billing-events');
  for (const um of marked) {
    const id = Number(um.id);
    await setLegacy(tx, input.gymId, id, PENDING_REACTIVATION_STATUS, 'active', input.actor, true);
    await tx.query(
      `UPDATE plan_snapshots
          SET status = 'active', ends_at = NULL, closed_at = NULL, previous_end_date = NULL
        WHERE gym_id = ? AND anchor_plan_snapshot_id = ? AND status = ?`,
      [input.gymId, id, PENDING_REACTIVATION_STATUS]);
    // The plan is one of the activating set's billable plans (it was carried for entitlement only).
    await tx.query(
      `INSERT IGNORE INTO product_set_plan_snapshots (product_set_id, plan_snapshot_id, entitlement_only)
       SELECT ?, s.id, 0 FROM plan_snapshots s WHERE s.gym_id = ? AND s.anchor_plan_snapshot_id = ? AND s.status = 'active'`,
      [input.productSetId, input.gymId, id]);
    await tx.query(
      `UPDATE product_set_plan_snapshots j JOIN plan_snapshots s ON s.id = j.plan_snapshot_id
          SET j.entitlement_only = 0
        WHERE j.product_set_id = ? AND s.gym_id = ? AND s.anchor_plan_snapshot_id = ?`,
      [input.productSetId, input.gymId, id]);
    await recordStatusChange(tx, {
      gymId: input.gymId, userMembershipId: id, memberId: ownerId,
      previousStatus: CANCELS_AT_PERIOD_END_STATUS, newStatus: 'active', source: 'system', actorUserId: null,
    });
  }

  // The set's Membership Plan is its first billable plan.
  const { rows: first } = await tx.query<{ membership_plan_id: number | null; um_id: number | null }>(
    `SELECT s.membership_plan_id, s.anchor_plan_snapshot_id AS um_id FROM product_set_plan_snapshots j
       JOIN plan_snapshots s ON s.id = j.plan_snapshot_id
      WHERE j.product_set_id = ? AND j.entitlement_only = 0 ORDER BY j.id LIMIT 1`, [input.productSetId]);
  await tx.query('UPDATE product_sets SET membership_plan_id = ? WHERE id = ? AND gym_id = ?',
    [first[0]?.membership_plan_id ?? null, input.productSetId, input.gymId]);
  // A reactivated plan that is now the set's primary plan is the assignment the set projects: link it,
  // so the projection continues that assignment in place (no new assignment, no superseded copy).
  const primaryUm = first[0]?.um_id != null ? Number(first[0].um_id) : null;
  if (primaryUm != null && marked.some((m) => Number(m.id) === primaryUm)) {
    const { rows: linked } = await tx.query<{ um: number | null }>(
      `SELECT ${productSetAssignmentSql('ps')} AS um FROM product_sets ps WHERE ps.id = ?`, [input.productSetId]);
    if (linked[0]?.um == null) await linkProductSetToAssignment(tx, input.gymId, input.productSetId, primaryUm);
  }
  return marked.length;
}
