import type { Tx } from '../infra/db';
import type { ProductBenefitCategory } from '../domain/productClassification';

/**
 * #2125 stage 16 — the Products a Membership Plan includes are the **plan snapshot's own lines**
 * (`plan_session/oneoff/periodical_snapshots`, keyed by `plan_snapshot_id`); the version-keyed
 * `user_membership_session/oneoff/periodical` tables are gone. A version's editable plan — what a
 * Draft's section writers, the clone and the version-keyed loader mean by "the version's
 * benefits" — is its **primary** plan snapshot: the lowest id, the one the version's own legacy
 * plan row derives (plans added beside it are inherited or native copies with later ids).
 */
export const PLAN_LINE_TABLE: Record<ProductBenefitCategory, string> = {
  session: 'plan_session_snapshots',
  oneoff: 'plan_oneoff_snapshots',
  periodical: 'plan_periodical_snapshots',
};

export const PLAN_LINE_CATEGORIES: ProductBenefitCategory[] = ['session', 'oneoff', 'periodical'];

type Exec = { query: Tx['query'] };

/** The version's primary plan snapshot, or `null` for a plan-less version. */
export async function primaryPlanSnapshotId(exec: Exec, gymId: string, productSetId: number): Promise<number | null> {
  const { rows } = await exec.query<{ id: number }>(
    `SELECT s.id FROM product_set_plan_snapshots psj JOIN plan_snapshots s ON s.id = psj.plan_snapshot_id
      WHERE s.gym_id = ? AND psj.product_set_id = ? ORDER BY s.id LIMIT 1`, [gymId, productSetId]);
  return rows[0] ? Number(rows[0].id) : null;
}

/**
 * The plan snapshot of `userMembershipId` inside one version (#2125 stage 21): the copy that names the
 * assignment as its contract, else the version's primary snapshot (a Draft not yet linked).
 */
export async function planSnapshotOfAssignment(
  exec: Exec, gymId: string, productSetId: number, userMembershipId: number | null,
): Promise<number | null> {
  if (userMembershipId != null) {
    const { rows } = await exec.query<{ id: number }>(
      `SELECT s.id FROM product_set_plan_snapshots psj JOIN plan_snapshots s ON s.id = psj.plan_snapshot_id
        WHERE s.gym_id = ? AND psj.product_set_id = ? AND s.source_user_membership_id = ?
        ORDER BY s.id LIMIT 1`, [gymId, productSetId, userMembershipId]);
    if (rows[0]) return Number(rows[0].id);
  }
  return primaryPlanSnapshotId(exec, gymId, productSetId);
}

/**
 * Whether a plan's payer is also one of its beneficiaries (#2125 stage 22). Turning it off removes the owner's
 * beneficiary row; turning it on adds it. The flag survives the syncs and every copy of the snapshot.
 */
export async function setOwnerIsBeneficiary(
  exec: Exec, gymId: string, planSnapshotId: number, isBeneficiary: boolean,
): Promise<void> {
  await exec.query('UPDATE plan_snapshots SET owner_is_beneficiary = ? WHERE id = ? AND gym_id = ?',
    [isBeneficiary ? 1 : 0, planSnapshotId, gymId]);
  if (isBeneficiary) {
    await exec.query(
      `INSERT INTO plan_snapshot_beneficiaries (gym_id, plan_snapshot_id, member_id, is_owner)
       SELECT gym_id, id, member_id, 1 FROM plan_snapshots WHERE id = ? AND gym_id = ?
       ON DUPLICATE KEY UPDATE is_owner = 1`, [planSnapshotId, gymId]);
  } else {
    await exec.query(
      `DELETE b FROM plan_snapshot_beneficiaries b JOIN plan_snapshots s ON s.id = b.plan_snapshot_id
        WHERE b.plan_snapshot_id = ? AND b.gym_id = ? AND b.member_id = s.member_id`, [planSnapshotId, gymId]);
  }
}

/**
 * SQL for "this plan snapshot is inherited by the Product Set `setExpr`" (#2125 M4a): it carries over from
 * the previous Product Set rather than being added by this one. Two ways to say it while the model moves:
 * the stored `is_inherited` flag (a copy made by `cloneConfiguration()`), or the snapshot being linked by the
 * set's `previous_product_set_id` as well (a link, once M4b stops copying). M5 drops the flag and the first
 * term. `snap` is the plan snapshot alias and `setExpr` an expression for the set's id.
 */
export const planSnapshotInheritedSql = (snap: string, setExpr: string): string =>
  `(${snap}.is_inherited = 1 OR EXISTS (
      SELECT 1 FROM product_sets cur_ JOIN product_set_plan_snapshots jp_ ON jp_.product_set_id = cur_.previous_product_set_id
       WHERE cur_.id = ${setExpr} AND jp_.plan_snapshot_id = ${snap}.id))`;
