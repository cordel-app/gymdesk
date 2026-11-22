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
import { ASSIGNMENT_BENEFICIARIES } from '../domain/assignmentBeneficiaries';

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
  const anchorIds = rows
    .filter((r) => r.um_id != null && (anchors.get(Number(r.um_id)) ?? Number(r.id)) === Number(r.id))
    .map((r) => Number(r.id));
  await seedAnchorLifecycle(exec, gymId, anchorIds);
}

/**
 * #2125 M6b-51c-4 — an anchor's lifecycle as its `user_memberships` row states it. Since M6b-51d-7a
 * only the repair (`plan-assignments:settle`) reads it; a new anchor is seeded from itself.
 */
const ANCHOR_LIFECYCLE_FROM_LEGACY = `
  UPDATE plan_snapshots a
    JOIN user_memberships um ON um.id = a.source_user_membership_id AND um.gym_id = a.gym_id
     SET a.assignment_status = um.status, a.assignment_closed_at = um.closed_at,
         a.assignment_ends_at = um.ends_at, a.assignment_modified_at = um.modified_at,
         a.assignment_modified_by = um.modified_by
   WHERE a.assignment_id = a.id`;

/**
 * #2125 M6b-51d-7a — the seed reads the anchor snapshot itself: a new assignment's first snapshot is
 * written with the status, dates and modifier the assignment was created with, so its lifecycle starts
 * from those, never from the `user_memberships` row.
 */
async function seedAnchorLifecycle(exec: Exec, gymId: string, anchorIds: number[]): Promise<void> {
  if (anchorIds.length === 0) return;
  await exec.query(
    `UPDATE plan_snapshots a
        SET a.assignment_status = a.status, a.assignment_ends_at = a.ends_at,
            a.assignment_closed_at = NULL, a.assignment_modified_at = NULL, a.assignment_modified_by = NULL
      WHERE a.assignment_id = a.id AND a.gym_id = ? AND a.id IN (${anchorIds.map(() => '?').join(',')})
        AND a.assignment_status IS NULL`,
    [gymId, ...anchorIds]);
}

/**
 * #2125 M6b-51c-4 — the repair for anchors that fell out of step with their `user_memberships` row
 * (a change made by code deployed before the one writer mirrored it, e.g. between migration 453 and
 * the deploy). Run by `npm run plan-assignments:settle -- --execute`; answers how many it repaired.
 * The migration's own backfill does the same once (`backfillAssignmentLifecycle()`).
 */
export async function repairAnchorLifecycles(exec: Exec, gymId?: string): Promise<number> {
  const { rowCount } = await exec.query(
    `${ANCHOR_LIFECYCLE_FROM_LEGACY}
       AND (NOT (a.assignment_status <=> um.status) OR NOT (a.assignment_closed_at <=> um.closed_at)
            OR NOT (a.assignment_ends_at <=> um.ends_at) OR NOT (a.assignment_modified_at <=> um.modified_at)
            OR NOT (a.assignment_modified_by <=> um.modified_by))${gymId ? ' AND a.gym_id = ?' : ''}`,
    gymId ? [gymId] : []);
  return rowCount;
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
/**
 * #2125 M6b-51c-2 — the assignment-level facts a plan snapshot drops when it stops naming the
 * assignment it named (`replace_on_activation`, `replaces_assignment_id`, `deleted_at`/`deleted_by`).
 * They are written by the assignment's own writers, never copied from `user_memberships` by the sync.
 */
export const RESET_ASSIGNMENT_FACTS_SQL =
  'replace_on_activation = 0, replaces_assignment_id = NULL, deleted_at = NULL, deleted_by = NULL';

export async function nameAssignmentSnapshot(
  exec: Exec, gymId: string, productSetId: number, userMembershipId: number,
): Promise<void> {
  const primary = await primaryPlanSnapshotId(exec, gymId, productSetId);
  if (primary != null && !(await isPlanSnapshotShared(exec, productSetId, primary))) {
    // #2125 M6b-51c-2: a snapshot that comes to name another assignment drops the facts of the one
    // it named before (a copy made for an edit carries its source's); the new assignment's writers
    // write its own afterwards (`writeAssignmentReplacement()`). The facts are reset before the name
    // moves, since MySQL applies the assignments of one UPDATE left to right.
    await exec.query(
      `UPDATE plan_snapshots SET ${RESET_ASSIGNMENT_FACTS_SQL}, source_user_membership_id = ?
        WHERE id = ? AND gym_id = ? AND NOT (source_user_membership_id <=> ?)`,
      [userMembershipId, primary, gymId, userMembershipId]);
    await stampAssignmentIds(exec, gymId, [primary]);
  }
  await exec.query(`UPDATE product_sets SET ${PRODUCT_SET_ASSIGNMENT_ANCHOR_SQL} WHERE id = ? AND gym_id = ?`,
    [userMembershipId, productSetId, gymId]);
}

/**
 * #2125 M6b-51a — locks the assignment's anchor snapshot (`FOR UPDATE`), the row the assignment's
 * identity lives on. It is taken **after** the legacy row's own lock, the order every writer already
 * has (a legacy write, then the snapshot sync), so the two cannot deadlock; while `user_memberships`
 * is still the source of truth the legacy lock stays and this one is added beside it, so no writer
 * that locks only one of them stops excluding the others. Answers the anchor id, or null when no
 * snapshot names the assignment yet (nothing to lock).
 */
export async function lockAssignmentAnchor(exec: Exec, gymId: string, userMembershipId: number): Promise<number | null> {
  const anchor = await planAssignmentIdOf(exec, gymId, userMembershipId);
  if (anchor == null) return null;
  await exec.query('SELECT id FROM plan_snapshots WHERE id = ? AND gym_id = ? FOR UPDATE', [anchor, gymId]);
  return anchor;
}

/** What a writer reads of the assignment it has locked (`lockAssignmentRecord()`). */
export interface LockedAssignment {
  /** The legacy id the routes name. */
  id: number;
  anchor_id: number;
  member_id: number;
  membership_plan_id: number | null;
  status: string;
  /** `YYYY-MM-DD`, from the assignment's current snapshot (its anchor's when no Product Set links one). */
  starts_at: string;
  /** `YYYY-MM-DD`, the assignment's own end date (`assignment_ends_at`). */
  ends_at: string | null;
}

/**
 * #2125 M6b-51d-2 — the one lock a writer of an assignment takes, and what it reads while holding it.
 * Locks the assignment's anchor snapshot (`assignment_id = id`) `FOR UPDATE` and answers its owner,
 * plan and lifecycle off it (`assignment_status`, `assignment_ends_at`, which `writeAssignmentLifecycle()`
 * keeps exactly in step, M6b-51c-4), with the start date of its current snapshot. Replaces the
 * `SELECT … FROM user_memberships … FOR UPDATE` every writer took first: the anchor is the
 * assignment's record now, so it is what serialises two writers of one assignment. `null` when no
 * snapshot names the id (an unknown assignment), or when its status is outside `statusIn` / inside
 * `statusNotIn` (the guard the legacy read spelled in its WHERE; the row stays locked either way).
 */
export async function lockAssignmentRecord(
  exec: Exec, gymId: string, userMembershipId: number | string,
  guard: { statusIn?: readonly string[]; statusNotIn?: readonly string[] } = {},
): Promise<LockedAssignment | null> {
  const id = Number(userMembershipId);
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const { rows } = await exec.query<{
    anchor_id: number; member_id: number; membership_plan_id: number | null; status: string | null;
    ends_at: string | null; anchor_starts_at: string | null;
  }>(
    `SELECT a.id AS anchor_id, DATE_FORMAT(a.starts_at, '%Y-%m-%d') AS anchor_starts_at, a.member_id, a.membership_plan_id, a.assignment_status AS status,
            DATE_FORMAT(a.assignment_ends_at, '%Y-%m-%d') AS ends_at
       FROM plan_snapshots a
      WHERE a.gym_id = ? AND a.source_user_membership_id = ? AND a.assignment_id = a.id
      ORDER BY a.id LIMIT 1 FOR UPDATE`, [gymId, id]);
  const anchor = rows[0];
  if (!anchor || anchor.status == null) return null;
  const status = String(anchor.status);
  if (guard.statusIn && !guard.statusIn.includes(status)) return null;
  if (guard.statusNotIn && guard.statusNotIn.includes(status)) return null;
  const { rows: current } = await exec.query<{ starts_at: string | null }>(
    `SELECT DATE_FORMAT(pa.starts_at, '%Y-%m-%d') AS starts_at FROM plan_snapshots pa
      WHERE pa.gym_id = ? AND ${assignmentOfLegacyIdSql('?')} LIMIT 1`, [gymId, id]);
  return {
    id,
    anchor_id: Number(anchor.anchor_id),
    member_id: Number(anchor.member_id),
    membership_plan_id: anchor.membership_plan_id == null ? null : Number(anchor.membership_plan_id),
    status,
    starts_at: String(current[0]?.starts_at ?? anchor.anchor_starts_at),
    ends_at: anchor.ends_at,
  };
}

/** An assignment covering one of a set of Members, locked on its anchor (`lockAssignmentsCovering()`). */
export interface CoveringAssignment {
  /** The legacy id the routes name. */
  id: number;
  anchor_id: number;
  /** The owner. */
  member_id: number;
  membership_plan_id: number | null;
  status: string;
  /** `YYYY-MM-DD`, from the assignment's current snapshot (its anchor's when no Product Set links one). */
  starts_at: string;
  /** `YYYY-MM-DD`, the assignment's own end date (`assignment_ends_at`). */
  ends_at: string | null;
}

/**
 * #2125 M6b-51d-3 — the multi-row counterpart of `lockAssignmentRecord()`: every assignment in one of
 * `statuses` that one of `memberIds` owns or is a beneficiary of (`ASSIGNMENT_BENEFICIARIES`), locked on
 * its anchor snapshot and read off it. Replaces the conflict reads that scanned `user_memberships …
 * FOR UPDATE` (the one-plan check, the pending-payment check of a commit).
 *
 * Two statements on purpose. The first finds the candidates without a lock; the second locks exactly
 * their anchors by id (in id order, so two callers lock in one order) and re-reads the status there.
 * One locking statement over `plan_snapshots` would lock every snapshot of the gym it scans, and the
 * snapshot sync writes those rows in every billing path. An assignment that becomes live between the
 * two statements is not seen, the gap the legacy read's own doc already accepted for a Member with no
 * live plan (nothing to lock). Sorted by start date, then id, both descending.
 */
export async function lockAssignmentsCovering(
  exec: Exec, gymId: string, memberIds: readonly number[], statuses: readonly string[],
  opts: { excludeUserMembershipId?: number } = {},
): Promise<CoveringAssignment[]> {
  if (memberIds.length === 0 || statuses.length === 0) return [];
  const members = memberIds.map(() => '?').join(',');
  const states = statuses.map(() => '?').join(',');
  const exclude = opts.excludeUserMembershipId != null ? ' AND a.source_user_membership_id <> ?' : '';
  const excludeParams = opts.excludeUserMembershipId != null ? [Number(opts.excludeUserMembershipId)] : [];
  const { rows: candidates } = await exec.query<{ id: number }>(
    `SELECT DISTINCT a.source_user_membership_id AS id FROM plan_snapshots a
      WHERE a.gym_id = ? AND a.assignment_id = a.id AND a.source_user_membership_id IS NOT NULL
        AND a.assignment_status IN (${states})
        AND (a.member_id IN (${members})
             OR EXISTS (SELECT 1 FROM ${ASSIGNMENT_BENEFICIARIES} umm
                         WHERE umm.user_membership_id = a.source_user_membership_id AND umm.gym_id = a.gym_id
                           AND umm.member_id IN (${members})))${exclude}`,
    [gymId, ...statuses, ...memberIds, ...memberIds, ...excludeParams]);
  if (candidates.length === 0) return [];
  const ids = candidates.map((c) => Number(c.id));
  const { rows } = await exec.query<{
    id: number; anchor_id: number; member_id: number; membership_plan_id: number | null; status: string;
    starts_at: string | null; ends_at: string | null;
  }>(
    `SELECT a.source_user_membership_id AS id, a.id AS anchor_id, a.member_id, a.membership_plan_id,
            a.assignment_status AS status,
            COALESCE((SELECT DATE_FORMAT(pa.starts_at, '%Y-%m-%d') FROM plan_snapshots pa
                       WHERE pa.gym_id = a.gym_id AND ${assignmentOfLegacyIdSql('a.source_user_membership_id')} LIMIT 1),
                     DATE_FORMAT(a.starts_at, '%Y-%m-%d')) AS starts_at,
            DATE_FORMAT(a.assignment_ends_at, '%Y-%m-%d') AS ends_at
       FROM plan_snapshots a
      WHERE a.gym_id = ? AND a.assignment_id = a.id AND a.source_user_membership_id IN (${ids.map(() => '?').join(',')})
      ORDER BY a.id FOR UPDATE`,
    [gymId, ...ids]);
  return rows
    .filter((r) => r.status != null && statuses.includes(String(r.status)))
    .map((r) => ({
      id: Number(r.id), anchor_id: Number(r.anchor_id), member_id: Number(r.member_id),
      membership_plan_id: r.membership_plan_id == null ? null : Number(r.membership_plan_id),
      status: String(r.status), starts_at: String(r.starts_at), ends_at: r.ends_at,
    }))
    .sort((x, y) => (x.starts_at === y.starts_at ? y.id - x.id : (x.starts_at < y.starts_at ? 1 : -1)));
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
 * Identity is stamped on every snapshot the set links. The facts (since M6b-30, `modified_at`/`modified_by`;
 * `purchased_at` since M6b-51c-1 is its writers', `writeAssignmentPurchasedAt()`) are copied only onto a
 * snapshot no other Product Set links, like every other write of the sync: a shared snapshot is
 * immutable to the sets that link it. A lifecycle change on a shared snapshot is copied first
 * (`settleSharedPlanLifecycle()`, M6b-2), and the copy is then this set's own. M6b-51c-2: the
 * replacement (`replace_on_activation`, `replaces_assignment_id`) is written only by
 * `writeAssignmentReplacement()` and the deletion pair by nothing (no assignment is soft-deleted), so
 * neither is copied from `user_memberships` any more; a snapshot that changes assignment drops them
 * (`RESET_ASSIGNMENT_FACTS_SQL`).
 */
export async function syncPlanAssignment(tx: Exec, gymId: string, productSetId: number): Promise<void> {
  const { rows } = await tx.query<{ id: number; um_id: number | null; shared: number }>(
    `SELECT s.id, s.source_user_membership_id AS um_id,
            ${planSnapshotSharedSql('s.id', 'psj.product_set_id')} AS shared
       FROM product_set_plan_snapshots psj
       JOIN plan_snapshots s ON s.id = psj.plan_snapshot_id AND s.gym_id = ?
      WHERE psj.product_set_id = ?`, [gymId, productSetId]);
  if (rows.length === 0) {
    await syncProductSetAssignmentIds(tx, gymId, [productSetId]);
    return;
  }
  await stampAssignmentIds(tx, gymId, rows.map((r) => Number(r.id)));
  const umIds = rows.map((r) => r.um_id).filter((v): v is number => v != null).map(Number);
  await syncPaymentRequestAssignmentIds(tx, gymId, umIds);
  await syncProductSetAssignmentIds(tx, gymId, [productSetId], umIds);
  for (const r of rows) {
    if (Number(r.shared) === 1) continue;
    await tx.query(
      // M6b-51d-7a: the assignment's last modifier is its anchor's (`writeAssignmentLifecycle()`).
      `UPDATE plan_snapshots s
         JOIN plan_snapshots asg ON asg.gym_id = s.gym_id AND asg.id = s.assignment_id
          SET s.modified_at = asg.assignment_modified_at,
              s.modified_by = asg.assignment_modified_by
        WHERE s.id = ? AND s.gym_id = ?`,
      [r.id, gymId]);
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

/**
 * #2125 M6b-51c-1 — writes the assignment's `purchased_at` on its plan snapshots, the record readers
 * take it from (`OWNED_ASSIGNMENT_ROWS_SQL`, `ASSIGNMENT_HISTORY_ROWS_SQL`). The sync no longer copies
 * it from `user_memberships`: the writers that stamp it (the commit, the projection) write it here, in
 * their own transaction, and the legacy column is only dual-written for `plan-assignments:validate`
 * until the table goes. Written on the snapshots naming the assignment that no other Product Set links
 * (the rule every write of the sync keeps; a shared snapshot already carries the value it was written
 * with). `'fill'` stamps the current time where none is stored and leaves a stored one alone, skipping
 * a snapshot whose own status says the plan is over; a date sets that value.
 */
export async function writeAssignmentPurchasedAt(
  exec: Exec, gymId: string, userMembershipId: number, value: 'fill' | Date | string,
): Promise<void> {
  const set = value === 'fill' ? 's.purchased_at = COALESCE(s.purchased_at, UTC_TIMESTAMP())' : 's.purchased_at = ?';
  const guard = value === 'fill'
    ? "AND s.status NOT IN ('active_cancel_at_period_end','cancelled','expired','superseded')" : '';
  await exec.query(
    `UPDATE plan_snapshots s SET ${set}
      WHERE s.gym_id = ? AND s.source_user_membership_id = ? ${guard}
        AND NOT EXISTS (SELECT 1 FROM product_set_plan_snapshots j1
                         JOIN product_set_plan_snapshots j2
                           ON j2.plan_snapshot_id = j1.plan_snapshot_id AND j2.product_set_id <> j1.product_set_id
                        WHERE j1.plan_snapshot_id = s.id)`,
    value === 'fill' ? [gymId, userMembershipId] : [value, gymId, userMembershipId]);
}
