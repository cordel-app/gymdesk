/**
 * #2125 M4a — a Product Set edits only the plan snapshots it owns. A snapshot is immutable once another
 * Product Set uses it (Oscar: "never modify existing snapshots or their beneficiary relationships"), so
 * before a writer changes one, `ownPlanSnapshot()` makes sure the set being edited holds a snapshot of its
 * own: when the snapshot is linked by any *other* Product Set, it is copied (lines, beneficiaries,
 * Promotions) and the set's link is moved to the copy; otherwise it is returned unchanged.
 *
 * Since M4b-3 `cloneConfiguration()` links instead of copying, so every plan a Draft reuses unchanged is
 * shared with the previous Product Set and every plan-snapshot writer comes through here. The copy
 * **takes the link's place**: the set's existing junction row is re-pointed at the copy rather than
 * replaced, because a link's id is a plan's place in the set (`primaryPlanSnapshotId()` is the first
 * link) and a new row would move an edited primary plan to the end. `planSnapshotSharedSql()` in
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

  // The set stops using the shared snapshot and takes a copy of it (kept as the same assignment's
  // contract), in the place the shared one held: the link is re-pointed, never re-created.
  const copyId = await copyPlanSnapshotToVersion(tx, gymId, planSnapshotId, productSetId, { keepAssignment: true, link: false });
  await tx.query('UPDATE product_set_plan_snapshots SET plan_snapshot_id = ? WHERE product_set_id = ? AND plan_snapshot_id = ?',
    [copyId, productSetId, planSnapshotId]);
  return copyId;
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
      ORDER BY p.id DESC LIMIT 1`,
    [userMembershipId, userMembershipId, gymId]);
  if (!rows[0]) return null;
  return ownPlanSnapshot(tx, gymId, Number(rows[0].set_id), Number(rows[0].id));
}

/**
 * Deletes a Product Set and the plan snapshots only it linked (#2125 M5b). A snapshot names no Product Set
 * any more, so nothing cascades from the set to its snapshots: the set's links go with it (the junction
 * cascades) and every snapshot it linked that no other set still links is deleted after it, by reference.
 * A snapshot another set links is that set's contract and is left exactly as it is (Oscar, 2026-11-08:
 * "Draft-only snapshots are cleaned up according to their references and dependencies. Shared snapshots
 * must be preserved."). `status` guards the delete: a set in any other status is not deleted and its
 * snapshots are not touched. Answers whether the set was deleted.
 */
export async function deleteProductSetAndOwnPlanSnapshots(
  tx: Tx, gymId: string, productSetId: number, status: 'draft' | 'pending_payment',
): Promise<boolean> {
  const { rows: linked } = await tx.query<{ id: number }>(
    `SELECT j.plan_snapshot_id AS id FROM product_set_plan_snapshots j
       JOIN product_sets ps ON ps.id = j.product_set_id AND ps.gym_id = ? AND ps.status = ?
      WHERE j.product_set_id = ?`, [gymId, status, productSetId]);
  const { rowCount } = await tx.query(
    'DELETE FROM product_sets WHERE id = ? AND gym_id = ? AND status = ?', [productSetId, gymId, status]);
  if (Number(rowCount ?? 0) === 0) return false;
  const ids = linked.map((r) => Number(r.id));
  if (ids.length > 0) {
    await tx.query(
      `DELETE FROM plan_snapshots
        WHERE gym_id = ? AND id IN (${ids.map(() => '?').join(',')})
          AND NOT EXISTS (SELECT 1 FROM product_set_plan_snapshots j WHERE j.plan_snapshot_id = plan_snapshots.id)`,
      [gymId, ...ids]);
  }
  return true;
}

/**
 * Discards a Draft Product Set by what it actually references (M4b-0, M5b): a plan snapshot another set
 * still links stays that set's, and everything only the Draft used goes with it. A set past `draft` is
 * never deleted here.
 */
export async function discardDraftSet(tx: Tx, gymId: string, productSetId: number): Promise<boolean> {
  return deleteProductSetAndOwnPlanSnapshots(tx, gymId, productSetId, 'draft');
}
