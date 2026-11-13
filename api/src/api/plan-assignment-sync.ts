/**
 * #2125 M6b-1 — the assignment's identity and assignment-level facts on `plan_snapshots`
 * (migration 419), dual-written while `user_memberships` is still the source of truth.
 *
 * `plan_snapshots.assignment_id` is the stable identity of the logical Membership Plan assignment:
 * the id of the assignment's first snapshot. It is decided here and nowhere else:
 *
 *   - a snapshot naming a `user_memberships` row (`source_user_membership_id`) takes the lowest
 *     snapshot id naming that row, so one legacy assignment is exactly one `assignment_id` for as
 *     long as both exist (which is what lets M6b-3 re-key every reference through the pair);
 *   - a snapshot naming none keeps the assignment it was given (a copy is given its source's by
 *     `copyPlanSnapshotToVersion()`), else it is its own.
 *
 * Nothing reads these columns yet. `npm run plan-assignments:validate` reports where the two
 * sides disagree, and M6b-4 may only drop `user_memberships` once that is clean.
 */
import type { Tx } from '../infra/db';
import { planSnapshotSharedSql } from './plan-snapshot-lines';

type Exec = { query: Tx['query'] };

/**
 * The lowest snapshot id naming each of the given `user_memberships` rows. Asked per assignment (the
 * `source_user_membership_id` index), never as a scan of the gym's snapshots: the sync runs on every
 * Draft edit.
 */
async function anchorsOf(exec: Exec, gymId: string, userMembershipIds: number[]): Promise<Map<number, number>> {
  const ids = [...new Set(userMembershipIds)];
  const anchors = new Map<number, number>();
  if (ids.length === 0) return anchors;
  const { rows } = await exec.query<{ um_id: number; anchor_id: number }>(
    `SELECT source_user_membership_id AS um_id, MIN(id) AS anchor_id FROM plan_snapshots
      WHERE gym_id = ? AND source_user_membership_id IN (${ids.map(() => '?').join(',')})
      GROUP BY source_user_membership_id`, [gymId, ...ids]);
  for (const r of rows) anchors.set(Number(r.um_id), Number(r.anchor_id));
  return anchors;
}

/** Stamps `assignment_id` on the given snapshots (see the module comment for the rule). */
export async function stampAssignmentIds(exec: Exec, gymId: string, planSnapshotIds: number[]): Promise<void> {
  if (planSnapshotIds.length === 0) return;
  const marks = planSnapshotIds.map(() => '?').join(',');
  const { rows } = await exec.query<{ id: number; um_id: number | null; assignment_id: number | null }>(
    `SELECT id, source_user_membership_id AS um_id, assignment_id FROM plan_snapshots
      WHERE gym_id = ? AND id IN (${marks})`, [gymId, ...planSnapshotIds]);
  const anchors = await anchorsOf(exec, gymId, rows.filter((r) => r.um_id != null).map((r) => Number(r.um_id)));
  for (const r of rows) {
    const current = r.assignment_id == null ? null : Number(r.assignment_id);
    const wanted = r.um_id != null ? (anchors.get(Number(r.um_id)) ?? Number(r.id)) : (current ?? Number(r.id));
    if (wanted !== current) {
      await exec.query('UPDATE plan_snapshots SET assignment_id = ? WHERE id = ? AND gym_id = ?', [wanted, r.id, gymId]);
    }
  }
}

export async function stampAssignmentId(exec: Exec, gymId: string, planSnapshotId: number): Promise<void> {
  await stampAssignmentIds(exec, gymId, [planSnapshotId]);
}

/**
 * Keeps the identity and the assignment-level facts of a Product Set's plan snapshots in step with
 * the assignments they name. Called by `syncPlanSnapshot()`, so every path that re-derives a set's
 * snapshots re-derives these too.
 *
 * Identity is stamped on every snapshot the set links. The facts (`purchased_at`,
 * `replace_on_activation`, `replaces_assignment_id`, `deleted_at`/`deleted_by`) are copied only onto a
 * snapshot no other Product Set links, like every other write of the sync: a shared snapshot is
 * immutable to the sets that link it. A lifecycle change on a shared snapshot is copied first
 * (`settleSharedPlanLifecycle()`, M6b-2), and the copy is then this set's own.
 */
export async function syncPlanAssignment(tx: Exec, gymId: string, productSetId: number): Promise<void> {
  const { rows } = await tx.query<{ id: number; replaces: number | null; shared: number }>(
    `SELECT s.id, um.replaces_user_membership_id AS replaces,
            ${planSnapshotSharedSql('s.id', 'psj.product_set_id')} AS shared
       FROM product_set_plan_snapshots psj
       JOIN plan_snapshots s ON s.id = psj.plan_snapshot_id AND s.gym_id = ?
       LEFT JOIN user_memberships um ON um.id = s.source_user_membership_id AND um.gym_id = s.gym_id
      WHERE psj.product_set_id = ?`, [gymId, productSetId]);
  if (rows.length === 0) return;
  await stampAssignmentIds(tx, gymId, rows.map((r) => Number(r.id)));
  const replaced = await anchorsOf(tx, gymId, rows.filter((r) => r.replaces != null).map((r) => Number(r.replaces)));
  for (const r of rows) {
    if (Number(r.shared) === 1) continue;
    await tx.query(
      `UPDATE plan_snapshots s
         JOIN user_memberships um ON um.id = s.source_user_membership_id AND um.gym_id = s.gym_id
          SET s.purchased_at = um.purchased_at,
              s.replace_on_activation = um.replace_on_activation,
              s.replaces_assignment_id = ?,
              s.deleted_at = um.deleted_at,
              s.deleted_by = um.deleted_by
        WHERE s.id = ? AND s.gym_id = ?`,
      [r.replaces != null ? (replaced.get(Number(r.replaces)) ?? null) : null, r.id, gymId]);
  }
}

/**
 * Deletes plan snapshots no Product Set links any more, and is the only way production code deletes
 * one. The anchor of an assignment (`assignment_id = id`) is never deleted while another snapshot of
 * that assignment survives: the self FK refuses it, and such a row is skipped here so the rest of the
 * delete still happens. InnoDB also refuses to delete a row that references itself under RESTRICT, so
 * a snapshot about to go is un-anchored first, in the same transaction. Two passes, so an anchor whose
 * only dependants went in the first goes in the second. M6b-2: nor is a snapshot whose Promotion
 * snapshots a lifecycle copy reuses (`promotions_plan_snapshot_id`), which would leave the copy with none.
 */
export async function deleteUnlinkedPlanSnapshots(exec: Exec, gymId: string, planSnapshotIds: number[]): Promise<void> {
  if (planSnapshotIds.length === 0) return;
  const marks = planSnapshotIds.map(() => '?').join(',');
  for (let pass = 0; pass < 2; pass += 1) {
    const { rows } = await exec.query<{ id: number }>(
      `SELECT s.id FROM plan_snapshots s
        WHERE s.gym_id = ? AND s.id IN (${marks})
          AND NOT EXISTS (SELECT 1 FROM product_set_plan_snapshots j WHERE j.plan_snapshot_id = s.id)
          AND NOT EXISTS (SELECT 1 FROM plan_snapshots o WHERE o.assignment_id = s.id AND o.id <> s.id)
          AND NOT EXISTS (SELECT 1 FROM plan_snapshots h WHERE h.promotions_plan_snapshot_id = s.id)`,
      [gymId, ...planSnapshotIds]);
    const ids = rows.map((r) => Number(r.id));
    if (ids.length === 0) return;
    const idMarks = ids.map(() => '?').join(',');
    await exec.query(
      `UPDATE plan_snapshots SET assignment_id = NULL WHERE gym_id = ? AND id IN (${idMarks}) AND assignment_id = id`,
      [gymId, ...ids]);
    await exec.query(`DELETE FROM plan_snapshots WHERE gym_id = ? AND id IN (${idMarks})`, [gymId, ...ids]);
  }
}
