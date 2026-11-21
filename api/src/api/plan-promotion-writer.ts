import type { Tx } from '../infra/db';
import { primaryPlanSnapshotId } from './plan-snapshot-lines';

/**
 * #3026 stage 3a — a Membership Plan Promotion application is written onto the plan snapshot it
 * applies to (`plan_promotion_snapshots`) by the writer that applies, revokes or confirms it, in the
 * same transaction, instead of waiting for `syncPlanSnapshot()` to derive the row from
 * `user_membership_promotions`.
 *
 * Until stage 3c moves the clone and the projection onto plan snapshots, those writers still rely on
 * the derivation, and `source_id` (the legacy application id) is the key both paths agree on, so a
 * row written here and the same row derived later are one row. Product-target applications and
 * grant snapshot rows are not handled here.
 */

/** Records an application on the version's primary plan snapshot (idempotent per `source_id`). */
export async function recordPlanPromotionApplied(
  tx: Tx, gymId: string, productSetId: number,
  application: { id: number; promotionId: number; actor: string | null },
): Promise<void> {
  const snapshotId = await primaryPlanSnapshotId(tx, gymId, productSetId);
  if (snapshotId == null) return;
  await tx.query(
    `INSERT INTO plan_promotion_snapshots
       (gym_id, plan_snapshot_id, source_id, promotion_id, status, is_inherited, snapshot,
        applied_at, created_at, created_by)
     VALUES (?, ?, ?, ?, 'applied', 0, NULL, UTC_TIMESTAMP(), UTC_TIMESTAMP(), ?)
     ON DUPLICATE KEY UPDATE status = VALUES(status)`,
    [gymId, snapshotId, application.id, application.promotionId, application.actor]);
}

/** A Draft's reference removed: the row goes with the application. */
export async function deletePlanPromotionReferences(
  tx: Tx, gymId: string, applicationIds: number[],
): Promise<void> {
  if (applicationIds.length === 0) return;
  await tx.query(
    `DELETE FROM plan_promotion_snapshots WHERE gym_id = ? AND source_id IN (${applicationIds.map(() => '?').join(',')})`,
    [gymId, ...applicationIds]);
}

/** A confirmed application revoked: kept, with the moment. */
export async function recordPlanPromotionRevoked(
  tx: Tx, gymId: string, productSetId: number, promotionId: number, actor: string | null,
): Promise<void> {
  await tx.query(
    `UPDATE plan_promotion_snapshots pps
       JOIN user_membership_promotions ump ON ump.id = pps.source_id AND ump.gym_id = pps.gym_id
        SET pps.status = 'revoked', pps.revoked_at = UTC_TIMESTAMP(),
            pps.modified_at = UTC_TIMESTAMP(), pps.modified_by = ?
      WHERE pps.gym_id = ? AND ump.product_set_id = ? AND ump.promotion_id = ?
        AND ump.recurrent_snapshot_id IS NULL AND pps.status = 'applied'`,
    [actor, gymId, productSetId, promotionId]);
}

/** A Draft confirmed: the snapshot the application was agreed with, taken from the Promotion as it stands. */
export async function recordPlanPromotionConfirmed(
  tx: Tx, gymId: string, applicationId: number, snapshotJson: string | null,
): Promise<void> {
  await tx.query(
    `UPDATE plan_promotion_snapshots SET snapshot = ?, modified_at = UTC_TIMESTAMP()
      WHERE gym_id = ? AND source_id = ?`,
    [snapshotJson, gymId, applicationId]);
}

const GRANT_TABLES: Array<{ target: string; source: string }> = [
  { target: 'plan_promotion_session_product_snapshots', source: 'user_membership_promotion_session_snapshot' },
  { target: 'plan_promotion_oneoff_product_snapshots', source: 'user_membership_promotion_oneoff_snapshot' },
  { target: 'plan_promotion_periodical_product_snapshots', source: 'user_membership_promotion_periodical_snapshot' },
];

/**
 * #3026 stage 3c-1 — the grant rows an application was agreed with are written under its plan
 * promotion snapshot by the confirming writer, in the transaction that freezes them, instead of
 * waiting for `syncPlanSnapshot()`. A grant row is keyed by the legacy grant id (`source_id`), the
 * key the derivation agrees on, so the later derivation lands on the same rows. An application with
 * no plan promotion snapshot (a Product-target one) writes nothing.
 */
export async function recordPlanPromotionGrants(tx: Tx, gymId: string, applicationId: number): Promise<void> {
  for (const { target, source } of GRANT_TABLES) {
    await tx.query(
      `INSERT INTO ${target}
         (gym_id, plan_promotion_snapshot_id, source_id, product_id, product_name, quantity, item_type,
          item_billing_frequency, unit_price, currency, \`action\`, \`value\`, requirement, created_at)
       SELECT g.gym_id, pps.id, g.id, g.product_id, g.product_name, g.quantity, g.item_type,
              g.item_billing_frequency, g.unit_price, g.currency, g.action, g.value, g.requirement, g.created_at
         FROM ${source} g
         JOIN plan_promotion_snapshots pps ON pps.source_id = g.user_membership_promotion_id AND pps.gym_id = g.gym_id
        WHERE g.gym_id = ? AND g.user_membership_promotion_id = ?
       ON DUPLICATE KEY UPDATE
         product_id = VALUES(product_id), product_name = VALUES(product_name), quantity = VALUES(quantity),
         item_type = VALUES(item_type), item_billing_frequency = VALUES(item_billing_frequency),
         unit_price = VALUES(unit_price), currency = VALUES(currency), \`action\` = VALUES(\`action\`),
         \`value\` = VALUES(\`value\`), requirement = VALUES(requirement)`,
      [gymId, applicationId]);
  }
}
