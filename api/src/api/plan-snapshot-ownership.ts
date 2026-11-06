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
