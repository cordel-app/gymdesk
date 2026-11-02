/**
 * #2125 — the plan snapshot model (migration 347) is the source of truth for a Membership Plan's
 * configuration (stage 17 removed the legacy `product_set_plan_snapshots` it was once derived
 * from). What is left to keep in step is derived from the version and its neighbours: status,
 * dates and the linked assignment, coverage, and the Membership Plan Promotion applications.
 */
import type { Tx } from '../infra/db';
import { syncProductSnapshotsOfVersion } from './product-snapshot-sync';
import { primaryPlanSnapshotId } from './plan-snapshot-lines';

const PROMOTION_PRODUCTS: Array<{ target: string; source: string }> = [
  { target: 'plan_promotion_session_product_snapshots', source: 'user_membership_promotion_session_snapshot' },
  { target: 'plan_promotion_oneoff_product_snapshots', source: 'user_membership_promotion_oneoff_snapshot' },
  { target: 'plan_promotion_periodical_product_snapshots', source: 'user_membership_promotion_periodical_snapshot' },
];

/**
 * Keeps a version's plan snapshots in step with the version and the assignments they are the
 * contract of (#2125 stage 17: the plan snapshot is the source of truth for a plan's
 * configuration; nothing here derives it from another table any more).
 *
 *   - every snapshot's status follows its version's, except where the assignment it names has
 *     moved on (paused, cancelled, expired), and `closed_at` follows that assignment;
 *   - the version's primary snapshot (the lowest id) takes the version's own member, plan, dates
 *     and linked assignment;
 *   - the primary snapshot's beneficiaries are the owner plus whoever the chain covers, and its
 *     Membership Plan Promotion applications are derived from the version's applications.
 */
export async function syncPlanSnapshot(tx: Tx, gymId: string, productSetId: number): Promise<void> {
  // #2126 stage 2: every write that re-derives a version's plan snapshot re-derives its Product lines too.
  await syncProductSnapshotsOfVersion(tx, gymId, productSetId);
  await tx.query(
    `UPDATE plan_snapshots s
       JOIN product_sets ps ON ps.id = s.product_set_id AND ps.gym_id = s.gym_id
       LEFT JOIN user_memberships um ON um.id = COALESCE(s.source_user_membership_id, ps.user_membership_id) AND um.gym_id = s.gym_id
        SET s.status = CASE WHEN ps.status = 'active' AND um.status IN ('paused','cancelled','expired') THEN um.status
                            ELSE ps.status END,
            s.closed_at = um.closed_at
      WHERE s.gym_id = ? AND s.product_set_id = ?`,
    [gymId, productSetId]);

  const snapshotId = await primaryPlanSnapshotId(tx, gymId, productSetId);
  if (snapshotId == null) return;
  await tx.query(
    `UPDATE plan_snapshots s
       JOIN product_sets ps ON ps.id = s.product_set_id AND ps.gym_id = s.gym_id
        SET s.member_id = ps.owner_member_id, s.membership_plan_id = COALESCE(ps.membership_plan_id, s.membership_plan_id),
            s.starts_at = ps.starts_at, s.ends_at = ps.ends_at,
            s.source_user_membership_id = COALESCE(ps.user_membership_id, s.source_user_membership_id)
      WHERE s.id = ?`,
    [snapshotId]);
  const { rows: snap } = await tx.query<{ id: number; member_id: number; root_product_set_id: number }>(
    `SELECT s.id, s.member_id, ps.root_product_set_id
       FROM plan_snapshots s JOIN product_sets ps ON ps.id = s.product_set_id
      WHERE s.id = ? AND s.gym_id = ?`, [snapshotId, gymId]);

  // Beneficiaries: the owner always, plus whoever the chain covers.
  await tx.query(
    `DELETE FROM plan_snapshot_beneficiaries
      WHERE plan_snapshot_id = ? AND member_id <> ?
        AND member_id NOT IN (SELECT member_id FROM product_set_members WHERE gym_id = ? AND root_product_set_id = ?)`,
    [snapshotId, snap[0].member_id, gymId, snap[0].root_product_set_id]);
  await tx.query(
    `INSERT INTO plan_snapshot_beneficiaries (gym_id, plan_snapshot_id, member_id, is_owner)
     SELECT ?, ?, ?, 1
     ON DUPLICATE KEY UPDATE is_owner = 1`,
    [gymId, snapshotId, snap[0].member_id]);
  await tx.query(
    `INSERT IGNORE INTO plan_snapshot_beneficiaries (gym_id, plan_snapshot_id, member_id, is_owner)
     SELECT ?, ?, psm.member_id, 0 FROM product_set_members psm
      WHERE psm.gym_id = ? AND psm.root_product_set_id = ? AND psm.member_id <> ?`,
    [gymId, snapshotId, gymId, snap[0].root_product_set_id, snap[0].member_id]);

  // #2125 stage 16: the included Products are the snapshot's own lines; nothing derives them here.

  // Membership Plan Promotion applications of this version (Product-target ones are not plan snapshots).
  await tx.query(
    `DELETE FROM plan_promotion_snapshots
      WHERE plan_snapshot_id = ?
        AND (source_id IS NULL OR source_id NOT IN (
              SELECT ump.id FROM user_membership_promotions ump
                JOIN promotions pr ON pr.id = ump.promotion_id AND pr.applies_to = 'membership_plan'
               WHERE ump.gym_id = ? AND ump.product_set_id = ? AND ump.recurrent_snapshot_id IS NULL))`,
    [snapshotId, gymId, productSetId]);
  await tx.query(
    `INSERT INTO plan_promotion_snapshots
       (gym_id, plan_snapshot_id, source_id, promotion_id, status, is_inherited, snapshot, applied_at, applied_by,
        consumed_at, revoked_at, created_at, created_by, modified_at, modified_by)
     SELECT ump.gym_id, ?, ump.id, ump.promotion_id, ump.status, 0, ump.snapshot, ump.applied_at, ump.applied_by,
            ump.consumed_at, ump.revoked_at, ump.applied_at, ump.created_by, ump.modified_at, ump.modified_by
       FROM user_membership_promotions ump
       JOIN promotions pr ON pr.id = ump.promotion_id AND pr.applies_to = 'membership_plan'
      WHERE ump.gym_id = ? AND ump.product_set_id = ? AND ump.recurrent_snapshot_id IS NULL
     ON DUPLICATE KEY UPDATE
       status = VALUES(status), snapshot = VALUES(snapshot), consumed_at = VALUES(consumed_at),
       revoked_at = VALUES(revoked_at), modified_at = VALUES(modified_at), modified_by = VALUES(modified_by)`,
    [snapshotId, gymId, productSetId]);

  for (const { target, source } of PROMOTION_PRODUCTS) {
    await tx.query(
      `DELETE t FROM ${target} t
         JOIN plan_promotion_snapshots pp ON pp.id = t.plan_promotion_snapshot_id
        WHERE pp.plan_snapshot_id = ?
          AND (t.source_id IS NULL OR t.source_id NOT IN (
                SELECT g.id FROM ${source} g WHERE g.gym_id = ? AND g.user_membership_promotion_id = pp.source_id))`,
      [snapshotId, gymId]);
    await tx.query(
      `INSERT INTO ${target}
         (gym_id, plan_promotion_snapshot_id, source_id, product_id, product_name, quantity, item_type,
          item_billing_frequency, unit_price, currency, \`action\`, \`value\`, requirement, created_at)
       SELECT g.gym_id, pp.id, g.id, g.product_id, g.product_name, g.quantity, g.item_type,
              g.item_billing_frequency, g.unit_price, g.currency, g.action, g.value, g.requirement, g.created_at
         FROM ${source} g
         JOIN plan_promotion_snapshots pp ON pp.source_id = g.user_membership_promotion_id AND pp.gym_id = g.gym_id
        WHERE pp.plan_snapshot_id = ?
       ON DUPLICATE KEY UPDATE
         product_id = VALUES(product_id), product_name = VALUES(product_name), quantity = VALUES(quantity),
         item_type = VALUES(item_type), item_billing_frequency = VALUES(item_billing_frequency),
         unit_price = VALUES(unit_price), currency = VALUES(currency), \`action\` = VALUES(\`action\`),
         \`value\` = VALUES(\`value\`), requirement = VALUES(requirement)`,
      [snapshotId]);
  }
}

/** Re-derives every version of a chain: coverage follows the chain, so a coverage change touches them all. */
export async function syncPlanSnapshotsOfChain(tx: Tx, gymId: string, rootProductSetId: number): Promise<void> {
  const { rows } = await tx.query<{ id: number }>(
    'SELECT id FROM product_sets WHERE gym_id = ? AND root_product_set_id = ?', [gymId, rootProductSetId]);
  for (const r of rows) await syncPlanSnapshot(tx, gymId, Number(r.id));
}

/** Re-derives the versions linked to an assignment — its status moved (paused, cancelled, expired). */
export async function syncPlanSnapshotsForAssignment(tx: Tx, gymId: string, userMembershipId: number): Promise<void> {
  const { rows } = await tx.query<{ id: number }>(
    'SELECT id FROM product_sets WHERE gym_id = ? AND user_membership_id = ?', [gymId, userMembershipId]);
  for (const r of rows) await syncPlanSnapshot(tx, gymId, Number(r.id));
}
