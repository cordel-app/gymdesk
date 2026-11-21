// #3026 stage 3c-3 — test fixture only. Production no longer derives a plan snapshot's Membership
// Plan Promotion rows from `user_membership_promotions` (`syncPlanSnapshot()` stopped in this
// stage; the writers in `plan-promotion-writer.ts` write them). A test that seeds an application in
// the legacy shape (`legacyChildQuery()`) still needs the plan snapshot rows the readers read, so
// the old derivation lives here, as the recurring-line one does (`recurringLineSnapshotFixture`).
import { db } from '../infra/db';
import { isPlanSnapshotShared, primaryPlanSnapshotId } from '../api/plan-snapshot-lines';

const PROMOTION_PRODUCTS: Array<{ target: string; source: string }> = [
  { target: 'plan_promotion_session_product_snapshots', source: 'user_membership_promotion_session_snapshot' },
  { target: 'plan_promotion_oneoff_product_snapshots', source: 'user_membership_promotion_oneoff_snapshot' },
  { target: 'plan_promotion_periodical_product_snapshots', source: 'user_membership_promotion_periodical_snapshot' },
];

export async function derivePlanPromotionSnapshotsForFixture(gymId: string, productSetId: number): Promise<void> {
  const snapshotId = await primaryPlanSnapshotId(db as any, gymId, productSetId);
  if (snapshotId == null) return;
  if (await isPlanSnapshotShared(db as any, productSetId, snapshotId)) return;
  // M6b-2: a lifecycle copy reuses the Promotion snapshots of the snapshot it was copied from
  // (`promotions_plan_snapshot_id`); none is derived onto it, or one application would be two records.
  const { rows: holder } = await db.query<{ holder: number | null }>(
    'SELECT promotions_plan_snapshot_id AS holder FROM plan_snapshots WHERE id = ? AND gym_id = ?', [snapshotId, gymId]);
  if (holder[0]?.holder != null) return;

  // Membership Plan Promotion applications of this version (Product-target ones are not plan snapshots).
  await db.query(
    `DELETE FROM plan_promotion_snapshots
      WHERE plan_snapshot_id = ?
        AND (source_id IS NOT NULL AND source_id NOT IN (
              SELECT ump.id FROM user_membership_promotions ump
                JOIN promotions pr ON pr.id = ump.promotion_id AND pr.applies_to = 'membership_plan'
               WHERE ump.gym_id = ? AND ump.product_set_id = ? AND ump.recurrent_snapshot_id IS NULL))`,
    [snapshotId, gymId, productSetId]);
  await db.query(
    `INSERT INTO plan_promotion_snapshots
       (gym_id, plan_snapshot_id, source_id, promotion_id, status, is_inherited, snapshot, applied_at, applied_by,
        consumed_at, revoked_at, created_at, created_by, modified_at, modified_by, snapshot_confirmed_at)
     SELECT ump.gym_id, ?, ump.id, ump.promotion_id, ump.status, 0, ump.snapshot, ump.applied_at, ump.applied_by,
            ump.consumed_at, ump.revoked_at, ump.applied_at, ump.created_by, ump.modified_at, ump.modified_by,
            ump.snapshot_confirmed_at
       FROM user_membership_promotions ump
       JOIN promotions pr ON pr.id = ump.promotion_id AND pr.applies_to = 'membership_plan'
      WHERE ump.gym_id = ? AND ump.product_set_id = ? AND ump.recurrent_snapshot_id IS NULL
     ON DUPLICATE KEY UPDATE
       status = VALUES(status), snapshot = VALUES(snapshot), applied_at = VALUES(applied_at), consumed_at = VALUES(consumed_at),
       revoked_at = VALUES(revoked_at), modified_at = VALUES(modified_at), modified_by = VALUES(modified_by),
       snapshot_confirmed_at = VALUES(snapshot_confirmed_at)`,
    [snapshotId, gymId, productSetId]);

  for (const { target, source } of PROMOTION_PRODUCTS) {
    await db.query(
      `DELETE t FROM ${target} t
         JOIN plan_promotion_snapshots pp ON pp.id = t.plan_promotion_snapshot_id
        WHERE pp.plan_snapshot_id = ?
          AND (t.source_id IS NULL OR t.source_id NOT IN (
                SELECT g.id FROM ${source} g WHERE g.gym_id = ? AND g.user_membership_promotion_id = pp.source_id))`,
      [snapshotId, gymId]);
    await db.query(
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
