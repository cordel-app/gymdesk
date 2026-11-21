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
import { isPlanSnapshotShared, planSnapshotSharedSql, primaryPlanSnapshotId } from './plan-snapshot-lines';
import { assignmentOfLegacyIdSql } from '../domain/planAssignments';

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
 * #2125 M6b-34 — keeps `payment_requests.plan_assignment_id` (migration 431) in step with
 * `user_membership_id`, the source of truth until M6b-4, by the rule `syncPromotionAssignmentIds()`
 * uses: a request of a legacy assignment takes that assignment's anchor, none where no snapshot names
 * it. A new request is stamped with the attempt (`recordPaymentAttempt()`); this re-sync, from
 * `syncPlanAssignment()`, covers an anchor that moved since. Nothing reads the column yet;
 * `plan-assignments:validate` reports drift (`payment_request_assignment_mismatch`).
 */
export async function syncPaymentRequestAssignmentIds(exec: Exec, gymId: string, userMembershipIds: number[]): Promise<void> {
  const ids = [...new Set(userMembershipIds)];
  if (ids.length === 0) return;
  const anchors = await anchorsOf(exec, gymId, ids);
  for (const umId of ids) {
    const anchor = anchors.get(umId) ?? null;
    await exec.query(
      `UPDATE payment_requests SET plan_assignment_id = ?
        WHERE gym_id = ? AND user_membership_id = ? AND NOT (plan_assignment_id <=> ?)`,
      [anchor, gymId, umId, anchor]);
  }
}

/**
 * #2125 M6b-36 / M6b-46 — the SET clause that links a Product Set to an assignment: its
 * `plan_assignment_id` (migration 432) becomes the anchor (lowest plan snapshot id) naming the
 * legacy assignment id bound to its one `?`. An unaliased `product_sets` is required. None where no
 * snapshot names that assignment yet; `nameAssignmentSnapshot()` names the set's primary snapshot and
 * re-links it. Since M6b-46 (migration 441) `product_sets.user_membership_id` is gone and this is the
 * only way a set is linked; a writer that unlinks a set writes `plan_assignment_id = NULL`.
 */
export const PRODUCT_SET_ASSIGNMENT_ANCHOR_SQL =
  `plan_assignment_id = (SELECT MIN(pa_anchor.id) FROM plan_snapshots pa_anchor
                          WHERE pa_anchor.gym_id = product_sets.gym_id
                            AND pa_anchor.source_user_membership_id = ?)`;

/** The lowest snapshot naming the same legacy assignment as the set's current anchor (none kept). */
const RENORMALIZED_ANCHOR_SQL =
  `COALESCE((SELECT MIN(pa_norm.id) FROM plan_snapshots pa_cur
               JOIN plan_snapshots pa_norm ON pa_norm.gym_id = pa_cur.gym_id
                                         AND pa_norm.source_user_membership_id = pa_cur.source_user_membership_id
              WHERE pa_cur.id = product_sets.plan_assignment_id), plan_assignment_id)`;

/**
 * #2125 M6b-36 / M6b-46 — keeps `product_sets.plan_assignment_id` pointing at its assignment's
 * anchor, the lowest snapshot naming the legacy assignment (the rule `stampAssignmentIds()` gives
 * every snapshot): the given sets, and every set whose anchor names one of the given assignments, are
 * re-pointed at that lowest snapshot when a lower one names the assignment after the set was linked.
 * The link itself is `plan_assignment_id` since M6b-46; this never links or unlinks a set.
 */
export async function syncProductSetAssignmentIds(
  exec: Exec, gymId: string, productSetIds: number[], userMembershipIds: number[] = [],
): Promise<void> {
  const sets = new Set(productSetIds.map(Number));
  const ums = [...new Set(userMembershipIds)];
  if (ums.length > 0) {
    // Found by a plain read first and written by primary key, so the UPDATE locks only those rows
    // (a range scan of the gym's sets under a concurrent writer deadlocks).
    const { rows } = await exec.query<{ id: number }>(
      `SELECT ps.id FROM product_sets ps
         JOIN plan_snapshots pa_um ON pa_um.id = ps.plan_assignment_id
        WHERE ps.gym_id = ? AND pa_um.source_user_membership_id IN (${ums.map(() => '?').join(',')})`,
      [gymId, ...ums]);
    for (const r of rows) sets.add(Number(r.id));
  }
  const ids = [...sets];
  if (ids.length === 0) return;
  // The comparison repeats the subquery rather than naming the column, so a set already in step is not
  // written (its row lock is not taken by a re-sync that changes nothing).
  await exec.query(
    `UPDATE product_sets SET plan_assignment_id = ${RENORMALIZED_ANCHOR_SQL}
      WHERE id IN (${ids.map(() => '?').join(',')}) AND gym_id = ? AND plan_assignment_id IS NOT NULL
        AND NOT (plan_assignment_id <=> ${RENORMALIZED_ANCHOR_SQL})`,
    [...ids, gymId]);
}

/**
 * #2125 M6b-44 — names a Product Set's primary plan snapshot after the assignment the set is linked
 * to, so the assignment's anchor exists as soon as the link does. Called by every writer that links a
 * set to a `user_memberships` row, once the set's primary snapshot is the one it will keep (after it
 * was frozen, cloned or owned), and before the set is synced. Until M6b-43 the snapshot sync named it
 * from `product_sets.user_membership_id`; since M6b-44 the sync reads the set's anchor, which only
 * exists once a snapshot names the assignment, so a link to an assignment no snapshot names yet (a new
 * Draft assignment, one the projection opens) is named here. A snapshot another Product Set links is
 * left alone, as the sync always left it, and the set's `plan_assignment_id` is re-derived after.
 */
export async function nameAssignmentSnapshot(
  exec: Exec, gymId: string, productSetId: number, userMembershipId: number,
): Promise<void> {
  const primary = await primaryPlanSnapshotId(exec, gymId, productSetId);
  if (primary != null && !(await isPlanSnapshotShared(exec, productSetId, primary))) {
    await exec.query(
      `UPDATE plan_snapshots SET source_user_membership_id = ?
        WHERE id = ? AND gym_id = ? AND NOT (source_user_membership_id <=> ?)`,
      [userMembershipId, primary, gymId, userMembershipId]);
    await stampAssignmentIds(exec, gymId, [primary]);
  }
  await exec.query(`UPDATE product_sets SET ${PRODUCT_SET_ASSIGNMENT_ANCHOR_SQL} WHERE id = ? AND gym_id = ?`,
    [userMembershipId, productSetId, gymId]);
}

/** #2125 M6b-34 — the anchor a new payment request of `userMembershipId` carries, or null. */
export async function planAssignmentIdOf(exec: Exec, gymId: string, userMembershipId: number | null): Promise<number | null> {
  if (userMembershipId == null) return null;
  return (await anchorsOf(exec, gymId, [Number(userMembershipId)])).get(Number(userMembershipId)) ?? null;
}

/**
 * Keeps the identity and the assignment-level facts of a Product Set's plan snapshots in step with
 * the assignments they name. Called by `syncPlanSnapshot()`, so every path that re-derives a set's
 * snapshots re-derives these too.
 *
 * Identity is stamped on every snapshot the set links. The facts (`purchased_at`,
 * `replace_on_activation`, `replaces_assignment_id`, `deleted_at`/`deleted_by` and, since M6b-30,
 * `modified_at`/`modified_by`) are copied only onto a
 * snapshot no other Product Set links, like every other write of the sync: a shared snapshot is
 * immutable to the sets that link it. A lifecycle change on a shared snapshot is copied first
 * (`settleSharedPlanLifecycle()`, M6b-2), and the copy is then this set's own.
 */
export async function syncPlanAssignment(tx: Exec, gymId: string, productSetId: number): Promise<void> {
  const { rows } = await tx.query<{ id: number; um_id: number | null; replaces: number | null; shared: number }>(
    `SELECT s.id, s.source_user_membership_id AS um_id, um.replaces_user_membership_id AS replaces,
            ${planSnapshotSharedSql('s.id', 'psj.product_set_id')} AS shared
       FROM product_set_plan_snapshots psj
       JOIN plan_snapshots s ON s.id = psj.plan_snapshot_id AND s.gym_id = ?
       LEFT JOIN user_memberships um ON um.id = s.source_user_membership_id AND um.gym_id = s.gym_id
      WHERE psj.product_set_id = ?`, [gymId, productSetId]);
  if (rows.length === 0) {
    await syncProductSetAssignmentIds(tx, gymId, [productSetId]);
    return;
  }
  await stampAssignmentIds(tx, gymId, rows.map((r) => Number(r.id)));
  const umIds = rows.map((r) => r.um_id).filter((v): v is number => v != null).map(Number);
  await syncPaymentRequestAssignmentIds(tx, gymId, umIds);
  await syncProductSetAssignmentIds(tx, gymId, [productSetId], umIds);
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
              s.deleted_by = um.deleted_by,
              s.modified_at = um.modified_at,
              s.modified_by = um.modified_by
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

/**
 * #2125 M6b-35 — the replacement an assignment carries, read from its **current** plan snapshot
 * (`assignmentOfLegacyIdSql()`): whether its activation replaces (`replace_on_activation`, written
 * by Save & Pay) and which assignment it was raised to replace (`replaces_assignment_id`, written by
 * `assign-new-plan`), reported as that assignment's legacy id because the live conflicts it is
 * matched against (`replacementTargets()`) are still named by it. The commit and Save & Pay read it
 * after locking the legacy row, so the snapshot they read is the one their own transaction wrote.
 * An assignment no snapshot states replaces nothing.
 */
export async function assignmentReplacementOf(
  exec: Exec, gymId: string, userMembershipId: number,
): Promise<{ replaceOnActivation: boolean; replacesUserMembershipId: number | null }> {
  const { rows } = await exec.query<{ replace_on_activation: number | null; replaces: number | null }>(
    `SELECT pa.replace_on_activation,
            (SELECT rep.source_user_membership_id FROM plan_snapshots rep
              WHERE rep.id = pa.replaces_assignment_id AND rep.gym_id = pa.gym_id) AS replaces
       FROM plan_snapshots pa
      WHERE pa.gym_id = ? AND ${assignmentOfLegacyIdSql('?')}
      LIMIT 1`, [gymId, userMembershipId]);
  const r = rows[0];
  return {
    replaceOnActivation: Number(r?.replace_on_activation ?? 0) === 1,
    replacesUserMembershipId: r?.replaces == null ? null : Number(r.replaces),
  };
}

/**
 * #2125 M6b-35 — writes an assignment's replacement on its own plan snapshots (those no other
 * Product Set links, the rule every write of the sync keeps): `replaces_assignment_id` as the anchor
 * of the replaced assignment, `replace_on_activation` as given. A field left `undefined` is not
 * written. `user_memberships` still carries both columns (dual-written until the table goes); this
 * is the writer the reader above depends on, so it does not wait for a later sync.
 */
export async function writeAssignmentReplacement(
  exec: Exec, gymId: string, userMembershipId: number,
  change: { replaceOnActivation?: boolean; replacesUserMembershipId?: number | null },
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (change.replaceOnActivation !== undefined) {
    sets.push('s.replace_on_activation = ?');
    params.push(change.replaceOnActivation ? 1 : 0);
  }
  if (change.replacesUserMembershipId !== undefined) {
    const replaced = change.replacesUserMembershipId;
    const anchor = replaced == null ? null
      : (await anchorsOf(exec, gymId, [Number(replaced)])).get(Number(replaced)) ?? null;
    sets.push('s.replaces_assignment_id = ?');
    params.push(anchor);
  }
  if (sets.length === 0) return;
  await exec.query(
    `UPDATE plan_snapshots s SET ${sets.join(', ')}
      WHERE s.gym_id = ? AND s.source_user_membership_id = ?
        AND NOT EXISTS (SELECT 1 FROM product_set_plan_snapshots j1
                         JOIN product_set_plan_snapshots j2
                           ON j2.plan_snapshot_id = j1.plan_snapshot_id AND j2.product_set_id <> j1.product_set_id
                        WHERE j1.plan_snapshot_id = s.id)`,
    [...params, gymId, userMembershipId]);
}
