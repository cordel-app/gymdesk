import type { Tx } from '../infra/db';
import { PENDING_CANCELLATION_STATUS, CANCELS_AT_PERIOD_END_STATUS } from '../domain/assignmentStatus';
import { cancellationEndDate } from '../domain/cancellationEntitlement';
import { loadPaidThrough } from './cancellation-entitlement';
import { closeAssignment } from './product-set-projection';
import { linkCancellingPlan } from './entitlement-plan-links';
import { assignmentOfLegacyIdSql } from '../domain/planAssignments';
import { writeAssignmentLifecycle } from './assignment-lifecycle-writer';

/**
 * #3007 stage 2(b) — the pending-cancellation lifecycle of a Membership Plan, backend only.
 *
 * Marking a plan (`markPlanForCancellation()`) puts it in the member's open Draft (opening one when
 * there is none) as `to_be_canceled`: the plan keeps running exactly like an `active` one
 * (`RUNNING_ASSIGNMENT_STATUSES`) and its snapshot remembers the `ends_at` it had
 * (`plan_snapshots.previous_end_date`). Nothing is cancelled until the Draft is committed:
 *
 *   - `commitPendingCancellations()` runs at the head of `activateWithEvents()` (Save & Pay's payment,
 *     or the free activation) and cancels each marked plan through the one cancellation rule
 *     (`cancellationEndDate()` over the paid periods, `closeAssignment()`), takes it out of the
 *     activating set's billable plans and carries it for entitlement only when it runs to a paid
 *     day. Nothing is charged for it.
 *   - `restorePendingCancellations()` runs when the Draft is discarded and puts every marked plan of
 *     the owner back exactly as it was, on the same snapshot.
 *
 * The status lives on the plan's own snapshot and is dual-written onto the `user_memberships` row
 * (the one `setLegacyStatus()` statement, in the style of M6b-47); no snapshot is copied for either move.
 * Everything else is read from `plan_snapshots`.
 */

/** The dual-write: the legacy row follows the snapshot, guarded on the status it moves away from. */
async function setLegacyStatus(tx: Tx, gymId: string, id: number, from: string, to: string, actor: string | null) {
  await writeAssignmentLifecycle(tx, gymId, id, { status: to, from, actor });
}

export interface PendingCancellationActor { name: string | null }

export type MarkOutcome =
  | { kind: 'ok'; productSetId: number; created: boolean }
  | { kind: 'already_marked'; productSetId: number | null }
  | { kind: 'not_found' }
  | { kind: 'not_running'; status: string }
  | { kind: 'in_flight'; productSetId: number; status: string };

const dateOnly = (v: unknown): string | null =>
  v == null ? null : (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);

/** Marks one running plan as pending cancellation, inside the owner's open Draft. */
export async function markPlanForCancellation(
  tx: Tx, input: { gymId: string; userMembershipId: number; actor: PendingCancellationActor; today: string },
): Promise<MarkOutcome> {
  const { rows } = await tx.query<{ id: number; member_id: number; status: string }>(
    `SELECT pa.source_user_membership_id AS id, pa.member_id, pa.status FROM plan_snapshots pa
      WHERE pa.gym_id = ? AND ${assignmentOfLegacyIdSql('?', 'pa')} ORDER BY pa.id DESC LIMIT 1 FOR UPDATE`,
    [input.gymId, input.userMembershipId]);
  const um = rows[0];
  if (!um) return { kind: 'not_found' };
  if (um.status === PENDING_CANCELLATION_STATUS) return { kind: 'already_marked', productSetId: null };
  if (um.status !== 'active') return { kind: 'not_running', status: um.status };

  const { ensureRecurringDraft } = await import('./recurring-purchase-draft');
  const draft = await ensureRecurringDraft(tx, {
    gymId: input.gymId, memberId: Number(um.member_id), actor: input.actor, today: input.today, staff: true,
  });
  if (draft.kind !== 'ok') return { kind: 'in_flight', productSetId: draft.productSetId, status: draft.status };

  await setLegacyStatus(tx, input.gymId, input.userMembershipId, 'active', PENDING_CANCELLATION_STATUS, input.actor.name);
  await tx.query(
    `UPDATE plan_snapshots SET status = ?, previous_end_date = ends_at
      WHERE gym_id = ? AND source_user_membership_id = ? AND status = 'active'`,
    [PENDING_CANCELLATION_STATUS, input.gymId, input.userMembershipId]);
  return { kind: 'ok', productSetId: draft.productSetId, created: draft.created };
}

/** Puts the marked plans back as they were (all of the owner's, or the one named). */
async function restore(tx: Tx, gymId: string, where: string, params: unknown[], actor: string | null): Promise<number> {
  const { rows } = await tx.query<{ id: number }>(
    `SELECT DISTINCT source_user_membership_id AS id FROM plan_snapshots
      WHERE gym_id = ? AND status = ? AND ${where}`,
    [gymId, PENDING_CANCELLATION_STATUS, ...params]);
  for (const r of rows) {
    await setLegacyStatus(tx, gymId, Number(r.id), PENDING_CANCELLATION_STATUS, 'active', actor);
    await tx.query(
      `UPDATE plan_snapshots SET status = 'active', ends_at = previous_end_date, previous_end_date = NULL
        WHERE gym_id = ? AND source_user_membership_id = ? AND status = ?`,
      [gymId, r.id, PENDING_CANCELLATION_STATUS]);
  }
  return rows.length;
}

/** Un-marks one plan. */
export async function unmarkPlanForCancellation(
  tx: Tx, input: { gymId: string; userMembershipId: number; actor: PendingCancellationActor },
): Promise<number> {
  return restore(tx, input.gymId, 'source_user_membership_id = ?', [input.userMembershipId], input.actor.name);
}

/** The Draft carrying the marks was discarded: every marked plan of the owner is restored. */
export async function restorePendingCancellations(
  tx: Tx, gymId: string, ownerMemberId: number, actor: string | null = null,
): Promise<number> {
  return restore(tx, gymId, 'member_id = ?', [ownerMemberId], actor);
}

/**
 * The Draft `productSetId` is being activated: each plan its owner marked is cancelled now — on its
 * last paid day (`active_cancel_at_period_end`) or at once — and leaves the set's billable plans, so
 * the activation generates no obligation for it. Called before the obligations are materialised.
 */
export async function commitPendingCancellations(
  tx: Tx, input: { gymId: string; productSetId: number; today: string; actor: string | null },
): Promise<number> {
  const { rows: sets } = await tx.query<{ owner_member_id: number }>(
    'SELECT owner_member_id FROM product_sets WHERE id = ? AND gym_id = ?', [input.productSetId, input.gymId]);
  if (!sets[0]) return 0;
  const { rows: marked } = await tx.query<{ id: number; starts_at: Date | string }>(
    `SELECT source_user_membership_id AS id, MIN(starts_at) AS starts_at FROM plan_snapshots
      WHERE gym_id = ? AND member_id = ? AND status = ? AND source_user_membership_id IS NOT NULL
      GROUP BY source_user_membership_id`,
    [input.gymId, Number(sets[0].owner_member_id), PENDING_CANCELLATION_STATUS]);
  if (marked.length === 0) return 0;

  const paidThrough = await loadPaidThrough(tx, input.gymId, input.productSetId);
  for (const um of marked) {
    const endsOn = cancellationEndDate({
      paidThrough, today: input.today, assignmentStart: dateOnly(um.starts_at) as string,
    });
    // The plan leaves the set's billable plans (the snapshot is the one the Draft cloned by link).
    await tx.query(
      `DELETE j FROM product_set_plan_snapshots j
         JOIN plan_snapshots s ON s.id = j.plan_snapshot_id
        WHERE j.product_set_id = ? AND j.entitlement_only = 0 AND s.gym_id = ? AND s.source_user_membership_id = ?`,
      [input.productSetId, input.gymId, Number(um.id)]);
    const closedAs = await closeAssignment(tx, input.gymId, Number(um.id), endsOn, input.actor);
    await tx.query(
      `UPDATE plan_snapshots SET previous_end_date = NULL
        WHERE gym_id = ? AND source_user_membership_id = ?`, [input.gymId, Number(um.id)]);
    if (closedAs === CANCELS_AT_PERIOD_END_STATUS) await linkCancellingPlan(tx, input.gymId, input.productSetId, Number(um.id));
  }

  // The set's Membership Plan is its first billable plan now (none when every plan was cancelled).
  const { rows: first } = await tx.query<{ membership_plan_id: number | null }>(
    `SELECT s.membership_plan_id FROM product_set_plan_snapshots j
       JOIN plan_snapshots s ON s.id = j.plan_snapshot_id
      WHERE j.product_set_id = ? AND j.entitlement_only = 0 ORDER BY j.id LIMIT 1`, [input.productSetId]);
  await tx.query('UPDATE product_sets SET membership_plan_id = ? WHERE id = ? AND gym_id = ?',
    [first[0]?.membership_plan_id ?? null, input.productSetId, input.gymId]);
  return marked.length;
}
