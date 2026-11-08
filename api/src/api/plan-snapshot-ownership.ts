/**
 * #2125 M4a — a Product Set edits only the plan snapshots it owns. A snapshot is immutable once another
 * Product Set uses it (Oscar: "never modify existing snapshots or their beneficiary relationships"), so
 * before a writer changes one, `ownPlanSnapshot()` makes sure the set being edited holds a snapshot of its
 * own: when the snapshot is linked by any *other* Product Set, it is copied (lines, beneficiaries,
 * Promotions) and the set's link is moved to the copy; otherwise it is returned unchanged.
 *
 * Today `cloneConfiguration()` still copies, so no snapshot is shared and this is a no-op; M4b stops the
 * copying and routes every plan-snapshot writer through it.
 */
import type { Tx } from '../infra/db';
import { assignmentVersionId } from './assignment-config';
import { copyPlanSnapshotToVersion } from './plan-snapshot-add';

export async function ownPlanSnapshot(
  tx: Tx, gymId: string, productSetId: number, planSnapshotId: number,
): Promise<number> {
  const { rows } = await tx.query<{ n: number }>(
    'SELECT COUNT(*) AS n FROM product_set_plan_snapshots WHERE plan_snapshot_id = ? AND product_set_id <> ?',
    [planSnapshotId, productSetId]);
  if (Number(rows[0]?.n ?? 0) === 0) return planSnapshotId;

  // The set stops using the shared snapshot and takes a copy of it (kept as the same assignment's contract).
  await tx.query('DELETE FROM product_set_plan_snapshots WHERE product_set_id = ? AND plan_snapshot_id = ?',
    [productSetId, planSnapshotId]);
  return copyPlanSnapshotToVersion(tx, gymId, planSnapshotId, productSetId, { keepAssignment: true });
}

/**
 * Makes the set own every plan snapshot it links (see `ownPlanSnapshot()`). The one call a writer that
 * addresses a set's snapshots by set (not by snapshot id) makes before its UPDATE.
 */
export async function ownPlanSnapshotsOfSet(tx: Tx, gymId: string, productSetId: number): Promise<void> {
  const { rows } = await tx.query<{ id: number }>(
    `SELECT psj.plan_snapshot_id AS id FROM product_set_plan_snapshots psj
       JOIN plan_snapshots s ON s.id = psj.plan_snapshot_id
      WHERE psj.product_set_id = ? AND s.gym_id = ? ORDER BY psj.plan_snapshot_id`, [productSetId, gymId]);
  for (const r of rows) await ownPlanSnapshot(tx, gymId, productSetId, Number(r.id));
}

/** Owns the snapshots of the version an assignment's configuration is currently on (M4b-0). */
export async function ownAssignmentSnapshots(tx: Tx, gymId: string, userMembershipId: number): Promise<void> {
  const { rows } = await tx.query<{ id: number | null }>(`SELECT ${assignmentVersionId('?')} AS id`, [userMembershipId]);
  if (rows[0]?.id != null) await ownPlanSnapshotsOfSet(tx, gymId, Number(rows[0].id));
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
