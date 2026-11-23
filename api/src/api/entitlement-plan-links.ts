import type { Tx } from '../infra/db';
import { CANCELS_AT_PERIOD_END_STATUS } from '../domain/assignmentStatus';
import { assignmentPlanSnapshotId } from './assignment-config';
import { isCurrentAssignmentSnapshotSql } from '../domain/planAssignments';

/**
 * #2659 stage 3 — a Product Set carries the plans the owner is cancelling at their period end.
 *
 * Cancelling a plan (`retireProjected()`) activates a version without it, so a Draft built from the
 * Active set (Add Membership Plan, `⋮ → Edit`, a recurring Product's Draft) used to lose every plan
 * that still runs to its last paid day. Such a plan is now **linked for entitlement only**: the same
 * plan snapshot (never a copy), with `product_set_plan_snapshots.entitlement_only = 1`.
 *
 * An entitlement link is the member's existing contract, kept visible and associated until it ends.
 * It changes nothing that contract does: it is never billed (the engine's loader), never part of an
 * initial charge, never projected (activating the set never re-opens the cancelled assignment) and
 * never the set's primary plan or an edit target. Every such reader asks `billablePlanLinkSql()`.
 * The snapshot is linked by the version that projected the assignment too, so it is shared and no
 * writer edits it, and deleting a Draft never deletes it.
 *
 * The links are derived again for each new set from the assignments' **stored** status, never copied
 * from the predecessor: a plan the nightly sweep has moved to `cancelled` stops being carried.
 */

/** SQL for "this junction row is a plan the set bills and projects": `alias` is the junction alias. */
export const billablePlanLinkSql = (alias: string): string => `${alias}.entitlement_only = 0`;

/**
 * Links, for entitlement only, the plan snapshot of each of the owner's assignments cancelling at
 * their period end and not yet past it. Idempotent (`INSERT IGNORE` on the junction's unique pair),
 * appended after the set's own links so the primary plan keeps its place. Answers how many plans the
 * set now carries this way.
 *
 * #2125 M6b-49: the assignments are read from `plan_snapshots` (each one's current snapshot, its
 * status and `ends_at`), never `user_memberships`, and the current snapshot is the one linked. A plan
 * cancelled inside the calling transaction does not carry its status on a snapshot yet (the sync runs
 * after the activation's projection), so the projection that closes it links it itself
 * (`linkCancellingPlan()`), and this read only has to find the plans cancelled earlier.
 */
export async function linkCancellingPlans(tx: Tx, gymId: string, productSetId: number): Promise<number> {
  const { rows: owner } = await tx.query<{ owner_member_id: number }>(
    'SELECT owner_member_id FROM product_sets WHERE id = ? AND gym_id = ?', [productSetId, gymId]);
  if (!owner[0]) return 0;
  const { rows } = await tx.query<{ snapshot_id: number }>(
    `SELECT pa.id AS snapshot_id
       FROM plan_snapshots pa
      WHERE pa.gym_id = ? AND pa.member_id = ? AND pa.status = ?
        AND pa.ends_at IS NOT NULL AND pa.ends_at >= UTC_DATE()
        AND ${isCurrentAssignmentSnapshotSql('pa')}
      ORDER BY pa.starts_at, pa.anchor_plan_snapshot_id`,
    [gymId, Number(owner[0].owner_member_id), CANCELS_AT_PERIOD_END_STATUS]);
  for (const r of rows) await linkForEntitlement(tx, productSetId, Number(r.snapshot_id));
  return rows.length;
}

/**
 * #2125 M6b-49 — links, for entitlement only, the plan an activation's projection has just closed as
 * `active_cancel_at_period_end` (`closeAssignment()`), by its legacy id. Its snapshot is the latest
 * set's that links it (the predecessor's: the set being activated carries no plan of it yet), the one
 * the sync then copies for the Active set and writes the cancellation on (M6b-2).
 */
export async function linkCancellingPlan(
  tx: Tx, gymId: string, productSetId: number, userMembershipId: number,
): Promise<void> {
  const { rows } = await tx.query<{ snapshot_id: number | null }>(
    `SELECT ${assignmentPlanSnapshotId('?', '?')} AS snapshot_id`, [userMembershipId, gymId]);
  if (rows[0]?.snapshot_id != null) await linkForEntitlement(tx, productSetId, Number(rows[0].snapshot_id));
}

async function linkForEntitlement(tx: Tx, productSetId: number, snapshotId: number): Promise<void> {
  await tx.query(
    `INSERT IGNORE INTO product_set_plan_snapshots (product_set_id, plan_snapshot_id, entitlement_only)
     VALUES (?, ?, 1)`, [productSetId, snapshotId]);
}
