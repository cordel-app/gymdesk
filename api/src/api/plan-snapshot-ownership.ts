/**
 * #2125 M4a — a Product Set edits only the plan snapshots it owns. A snapshot is immutable once another
 * Product Set uses it (Oscar: "never modify existing snapshots or their beneficiary relationships"), so
 * before a writer changes one, `ownPlanSnapshot()` makes sure the set being edited holds a snapshot of its
 * own: when the snapshot is linked by any *other* Product Set, it is copied (lines, beneficiaries,
 * Promotions) and the set's link is moved to the copy; otherwise it is returned unchanged.
 *
 * Today `cloneConfiguration()` still copies, so no snapshot is shared and this is a no-op; M4b stops the
 * copying and routes every plan-snapshot writer through it. `planSnapshotSharedSql()` in
 * `plan-snapshot-lines.ts` is the one spelling of "another Product Set links this snapshot" (M4b-1): the
 * sync and the owner both ask it, so a shared snapshot is never written by anything.
 */
import type { Tx } from '../infra/db';
import { assignmentPlanSnapshotId } from './assignment-config';
import { copyPlanSnapshotToVersion } from './plan-snapshot-add';
import { isPlanSnapshotShared, planSnapshotOfAssignment, primaryPlanSnapshotId } from './plan-snapshot-lines';

export async function ownPlanSnapshot(
  tx: Tx, gymId: string, productSetId: number, planSnapshotId: number,
): Promise<number> {
  if (!(await isPlanSnapshotShared(tx, productSetId, planSnapshotId))) return planSnapshotId;

  // The set stops using the shared snapshot and takes a copy of it (kept as the same assignment's contract).
  await tx.query('DELETE FROM product_set_plan_snapshots WHERE product_set_id = ? AND plan_snapshot_id = ?',
    [productSetId, planSnapshotId]);
  return copyPlanSnapshotToVersion(tx, gymId, planSnapshotId, productSetId, { keepAssignment: true });
}

/**
 * M4b-2 — a writer owns exactly the plan snapshot it is about to write, and only when it writes. Until
 * M4b-2 `lockDraft()` owned every snapshot the Draft linked (`ownPlanSnapshotsOfSet()`), which copied the
 * plans nobody was editing and made Oscar's "an unmodified plan is reused, not copied" impossible. The
 * three resolvers below answer the snapshot a writer addresses — the version's primary one, the one that
 * is a named assignment's contract, or the one an assignment's configuration is read from — own it, and
 * return the id to write: the copy's when the snapshot was shared, the snapshot's own otherwise. A writer
 * writes **by that id**, never through a `MIN(plan_snapshot_id)` subselect, because the copy carries a
 * higher id than the snapshot it replaces.
 */
export async function ownPrimaryPlanSnapshot(tx: Tx, gymId: string, productSetId: number): Promise<number | null> {
  const id = await primaryPlanSnapshotId(tx, gymId, productSetId);
  return id == null ? null : ownPlanSnapshot(tx, gymId, productSetId, id);
}

export async function ownAssignmentPlanSnapshot(
  tx: Tx, gymId: string, productSetId: number, userMembershipId: number | null,
): Promise<number | null> {
  const id = await planSnapshotOfAssignment(tx, gymId, productSetId, userMembershipId);
  return id == null ? null : ownPlanSnapshot(tx, gymId, productSetId, id);
}

/**
 * Owns the plan snapshot an assignment's configuration is read from (`assignmentPlanSnapshotId()`), for the
 * latest version linked to the assignment that links it; `null` for an assignment with none.
 */
export async function ownAssignmentSnapshot(tx: Tx, gymId: string, userMembershipId: number): Promise<number | null> {
  const { rows } = await tx.query<{ set_id: number; id: number }>(
    `SELECT j.product_set_id AS set_id, s.id
       FROM plan_snapshots s
       JOIN product_set_plan_snapshots j ON j.plan_snapshot_id = s.id
       JOIN product_sets p ON p.id = j.product_set_id AND p.gym_id = s.gym_id AND p.user_membership_id = ?
      WHERE s.id = ${assignmentPlanSnapshotId('?', '?')}
      ORDER BY p.version DESC, p.id DESC LIMIT 1`,
    [userMembershipId, userMembershipId, gymId]);
  if (!rows[0]) return null;
  return ownPlanSnapshot(tx, gymId, Number(rows[0].set_id), Number(rows[0].id));
}

/**
 * Discards a Draft Product Set by what it actually references (M4b-0): a plan snapshot another set still
 * links is handed to that set (so the delete's cascade cannot take it) and everything only the Draft used
 * goes with it. A set past `draft` is never deleted here.
 */
export async function discardDraftSet(tx: Tx, gymId: string, productSetId: number): Promise<boolean> {
  const { rows: shared } = await tx.query<{ snapshot: number; other: number }>(
    `SELECT mine.plan_snapshot_id AS snapshot, MIN(o.product_set_id) AS other
       FROM product_set_plan_snapshots mine
       JOIN product_sets ps ON ps.id = mine.product_set_id AND ps.gym_id = ? AND ps.status = 'draft'
       JOIN product_set_plan_snapshots o ON o.plan_snapshot_id = mine.plan_snapshot_id AND o.product_set_id <> mine.product_set_id
      WHERE mine.product_set_id = ? GROUP BY mine.plan_snapshot_id`, [gymId, productSetId]);
  for (const s of shared) {
    await tx.query('UPDATE plan_snapshots SET product_set_id = ? WHERE id = ? AND gym_id = ? AND product_set_id = ?',
      [Number(s.other), Number(s.snapshot), gymId, productSetId]);
  }
  const { rowCount } = await tx.query(
    `DELETE FROM product_sets WHERE id = ? AND gym_id = ? AND status = 'draft'`, [productSetId, gymId]);
  return Number(rowCount ?? 0) > 0;
}
