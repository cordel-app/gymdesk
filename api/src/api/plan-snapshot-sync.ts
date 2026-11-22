/**
 * #2125 — the plan snapshot model (migration 347) is the source of truth for a Membership Plan's
 * configuration (stage 17 removed the legacy `product_set_plan_snapshots` it was once derived
 * from). What is left to keep in step is derived from the version and its neighbours: status,
 * dates and the linked assignment, coverage, and the Membership Plan Promotion applications.
 */
import type { Tx } from '../infra/db';
import { syncProductSnapshotsOfVersion } from './product-snapshot-sync';
import { stampAssignmentIds, syncPlanAssignment } from './plan-assignment-sync';
import { settleSharedPlanLifecycle } from './plan-assignment-lifecycle';
import { isPlanSnapshotShared, planSnapshotSharedSql, primaryPlanSnapshotId } from './plan-snapshot-lines';
import { productSetLegacyAssignmentIdSql, productSetOfLegacyAssignmentSql } from '../domain/planAssignments';

/**
 * Keeps a version's plan snapshots in step with the version and the assignments they are the
 * contract of (#2125 stage 17: the plan snapshot is the source of truth for a plan's
 * configuration; nothing here derives it from another table any more).
 *
 *   - every snapshot's status follows its version's, except where the assignment it names has
 *     moved on (paused, cancelling at its period end, cancelled, expired; the assignment's own stored
 *     value since M6b-1, migration 419), and `closed_at` follows that assignment. M6b-6: the snapshot
 *     of a superseded version whose assignment ended (cancelled, expired) keeps that status rather
 *     than taking `superseded`, so a closed plan reads as what it is on its last snapshot. M6b-7: that
 *     snapshot also takes the assignment's end date (`ends_at`), for an assignment that is over
 *     (cancelled, expired, superseded), instead of its Product Set's;
 *   - the version's primary snapshot (the lowest id) takes the version's own member, plan, dates
 *     and linked assignment;
 *   - the primary snapshot's beneficiaries are the owner plus whoever the chain covers.
 *
 * Since M4b-1 the snapshots a version holds are the ones the junction links (`product_set_plan_snapshots`),
 * (since M5b a snapshot names no set at all), and **a snapshot linked by more than one Product Set is not
 * written at all** (`planSnapshotSharedSql()`): it is immutable to every set that links it and keeps the
 * state it had, which is Oscar's rule for an unmodified plan a Draft reuses from the active set. A writer
 * that needs to change such a snapshot owns it first (`ownPlanSnapshot()`), after which it is the set's
 * alone and this sync moves it again.
 */
export async function syncPlanSnapshot(tx: Tx, gymId: string, productSetId: number): Promise<void> {
  // #2125 M6b-51c-5: the statements below read each assignment's lifecycle off its anchor, so a
  // snapshot this set links is stamped (and a new anchor seeded) before they run, not after.
  const { rows: linked } = await tx.query<{ id: number }>(
    'SELECT plan_snapshot_id AS id FROM product_set_plan_snapshots WHERE product_set_id = ?', [productSetId]);
  await stampAssignmentIds(tx, gymId, linked.map((r) => Number(r.id)));
  // M6b-2: a lifecycle change on a snapshot another Product Set links is written on a copy made for
  // the Active set (same assignment), which the statements below then treat as the set's own.
  await settleSharedPlanLifecycle(tx, gymId, productSetId);
  await syncPlanSnapshotConfiguration(tx, gymId, productSetId);
  // M6b-1: the assignment's identity and assignment-level facts follow every re-derivation.
  await syncPlanAssignment(tx, gymId, productSetId);
}

async function syncPlanSnapshotConfiguration(tx: Tx, gymId: string, productSetId: number): Promise<void> {
  // #2126 stage 2: every write that re-derives a version's plan snapshot re-derives its Product lines too.
  await syncProductSnapshotsOfVersion(tx, gymId, productSetId);
  // #2125 M6b-44: the assignment the set is linked to is read off its anchor (`plan_assignment_id`),
  // never `product_sets.user_membership_id`. Read first, apart from the UPDATEs below: they write
  // `plan_snapshots`, which MySQL will not let a subquery of the same statement read (error 1093). An
  // assignment no snapshot names yet has no anchor; its writer named the snapshot when it linked the
  // set (`nameAssignmentSnapshot()`), so nothing is lost by reading none here.
  const { rows: linkRows } = await tx.query<{ um_id: number | null }>(
    `SELECT ${productSetLegacyAssignmentIdSql('ps')} AS um_id FROM product_sets ps WHERE ps.id = ? AND ps.gym_id = ?`,
    [productSetId, gymId]);
  const linkedUmId = linkRows[0]?.um_id != null ? Number(linkRows[0].um_id) : null;
  // #2125 M6b-51c-5: the assignment's lifecycle is read off its anchor snapshot (`asg`, migration 453),
  // never `user_memberships`.
  // Status and closed_at of every snapshot the version links and no other set does. M6b-7: and the
  // day an assignment that is over ended, on the snapshot of its superseded set (the last snapshot
  // of a plan that left the Active set), so the snapshot dates the plan as its assignment does.
  // M6b-32: likewise on a cancelled set (a Pending Payment assignment closed before it was paid
  // keeps its set as `cancelled`, #2747), whose snapshot is that assignment's last.
  await tx.query(
    `UPDATE plan_snapshots s
       JOIN product_set_plan_snapshots psj ON psj.plan_snapshot_id = s.id AND psj.product_set_id = ? AND psj.entitlement_only = 0
       JOIN product_sets ps ON ps.id = psj.product_set_id AND ps.gym_id = s.gym_id
       LEFT JOIN plan_snapshots asg ON asg.gym_id = s.gym_id AND asg.assignment_id = asg.id
                                   AND asg.source_user_membership_id = COALESCE(s.source_user_membership_id, ?)
        SET s.status = CASE WHEN ps.status = 'active'
                                 AND asg.assignment_status IN ('paused','to_be_canceled','active_cancel_at_period_end','to_be_reactivated','cancelled','expired') THEN asg.assignment_status
                            WHEN ps.status = 'superseded' AND asg.assignment_status IN ('cancelled','expired') THEN asg.assignment_status
                            ELSE ps.status END,
            s.closed_at = asg.assignment_closed_at,
            s.ends_at = IF(ps.status IN ('superseded','cancelled') AND asg.assignment_status IN ('cancelled','expired','superseded'), asg.assignment_ends_at, s.ends_at)
      WHERE s.gym_id = ? AND NOT ${planSnapshotSharedSql('s.id', 'psj.product_set_id')}`,
    [productSetId, linkedUmId, gymId]);

  const snapshotId = await primaryPlanSnapshotId(tx, gymId, productSetId);
  if (snapshotId == null) return;
  // A primary snapshot another set links is that set's contract too: nothing below may move it.
  if (await isPlanSnapshotShared(tx, productSetId, snapshotId)) return;
  // The dates are the set's, except the end date of a closed assignment on a superseded or cancelled set, which
  // the statement above took from the assignment (M6b-7) and the set's own end date must not undo.
  await tx.query(
    `UPDATE plan_snapshots s
       JOIN product_sets ps ON ps.id = ? AND ps.gym_id = s.gym_id
        SET s.member_id = ps.owner_member_id, s.membership_plan_id = COALESCE(ps.membership_plan_id, s.membership_plan_id),
            s.starts_at = ps.starts_at,
            s.ends_at = IF(ps.status IN ('superseded','cancelled') AND s.closed_at IS NOT NULL, s.ends_at, ps.ends_at),
            s.replace_on_activation = IF(? IS NOT NULL AND NOT (s.source_user_membership_id <=> ?), 0, s.replace_on_activation),
            s.replaces_assignment_id = IF(? IS NOT NULL AND NOT (s.source_user_membership_id <=> ?), NULL, s.replaces_assignment_id),
            s.source_user_membership_id = COALESCE(?, s.source_user_membership_id)
      WHERE s.id = ?`,
    // #2125 M6b-51c-2: a snapshot renamed after another assignment drops the previous one's replacement
    // (reset before the name moves: one UPDATE assigns left to right). `nameAssignmentSnapshot()` names
    // it first on every path today, so this is the guard for a path that would not.
    [productSetId, linkedUmId, linkedUmId, linkedUmId, linkedUmId, linkedUmId, snapshotId]);
  const { rows: snap } = await tx.query<{ id: number; member_id: number }>(
    'SELECT s.id, s.member_id FROM plan_snapshots s WHERE s.id = ? AND s.gym_id = ?', [snapshotId, gymId]);

  // Beneficiaries (#2125 stage 21): each snapshot's own; the sync only guarantees the owner's row.
  // The owner's row follows the plan's own choice (#2125 stage 22): a payer who is not a beneficiary has none.
  await tx.query(
    `INSERT INTO plan_snapshot_beneficiaries (gym_id, plan_snapshot_id, member_id, is_owner)
     SELECT s.gym_id, s.id, ?, 1 FROM plan_snapshots s WHERE s.id = ? AND s.owner_is_beneficiary = 1
     ON DUPLICATE KEY UPDATE is_owner = 1`,
    [snap[0].member_id, snapshotId]);
  await tx.query(
    `DELETE b FROM plan_snapshot_beneficiaries b JOIN plan_snapshots s ON s.id = b.plan_snapshot_id
      WHERE b.plan_snapshot_id = ? AND b.member_id = ? AND s.owner_is_beneficiary = 0`,
    [snapshotId, snap[0].member_id]);

  // #2125 stage 16: the included Products are the snapshot's own lines; nothing derives them here.

  // #3026 stage 3c-3: the Membership Plan Promotion applications are the snapshot's own rows, written
  // by their writers (`plan-promotion-writer.ts`) and copied with the snapshot; nothing derives them
  // from `user_membership_promotions` here any more.
}

/**
 * Re-derives the versions linked to an assignment — its status moved (paused, cancelled, expired).
 * M6b-2: and the owner's Active set whenever it links a snapshot of the assignment without being
 * "its" version (a plan beside the set's first, or one carried for entitlement only), so the
 * lifecycle change reaches the snapshot the assignment currently lives on. M6b-6: and the owner's
 * Active set whatever it links, last, so an assignment that ended and left that set is carried onto
 * it for the record (`carryClosedAssignments()`).
 */
export async function syncPlanSnapshotsForAssignment(tx: Tx, gymId: string, userMembershipId: number): Promise<void> {
  const { rows } = await tx.query<{ id: number }>(
    `SELECT ps.id FROM product_sets ps WHERE ps.gym_id = ? AND ${productSetOfLegacyAssignmentSql('?')}
     UNION
     SELECT p.id FROM product_sets p
       JOIN product_set_plan_snapshots j ON j.product_set_id = p.id
       JOIN plan_snapshots s ON s.id = j.plan_snapshot_id AND s.gym_id = p.gym_id
      WHERE p.gym_id = ? AND p.status = 'active' AND s.source_user_membership_id = ?
     UNION
     SELECT p.id FROM product_sets p
       JOIN plan_snapshots s ON s.gym_id = p.gym_id AND s.member_id = p.owner_member_id
      WHERE p.gym_id = ? AND p.status = 'active' AND s.source_user_membership_id = ?
     ORDER BY id`, [gymId, userMembershipId, gymId, userMembershipId, gymId, userMembershipId]);
  for (const r of rows) await syncPlanSnapshot(tx, gymId, Number(r.id));
}
