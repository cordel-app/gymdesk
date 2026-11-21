import type { Tx } from '../infra/db';
import { primaryPlanSnapshotId } from './plan-snapshot-lines';

/**
 * #3026 stage 3a — a Membership Plan Promotion application is written onto the plan snapshot it
 * applies to (`plan_promotion_snapshots`) by the writer that applies, revokes or confirms it, in the
 * same transaction, instead of waiting for `syncPlanSnapshot()` to derive the row from
 * `user_membership_promotions`.
 *
 * Since stage 3c-3 nothing derives these rows: `syncPlanSnapshot()` no longer reads the legacy table,
 * so the writers here are the only ones, with the snapshot copy (`copyPlanSnapshotToVersion()`).
 * `source_id` is the legacy application's id where one was written beside the row; a copy has none.
 * Product-target applications are not handled here.
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

/**
 * A confirmed application revoked: kept, with the moment. #3026 stage 3c-3: found on the version's
 * own primary plan snapshot by its Promotion (the caller owns that snapshot first), never through
 * the legacy application, so a copy made with the snapshot (no legacy twin) is revoked too.
 */
export async function recordPlanPromotionRevoked(
  tx: Tx, gymId: string, productSetId: number, promotionId: number, actor: string | null,
): Promise<void> {
  const snapshotId = await primaryPlanSnapshotId(tx, gymId, productSetId);
  if (snapshotId == null) return;
  await tx.query(
    `UPDATE plan_promotion_snapshots
        SET status = 'revoked', revoked_at = UTC_TIMESTAMP(), modified_at = UTC_TIMESTAMP(), modified_by = ?
      WHERE gym_id = ? AND plan_snapshot_id = ? AND promotion_id = ? AND status = 'applied'`,
    [actor, gymId, snapshotId, promotionId]);
}

/**
 * #3026 stage 3c-3 — what a superseded Product Set still had applied is history: the standing
 * applications on the plan snapshots that set alone links become `superseded`. A snapshot the
 * successor links too is its contract as well and is left as it is.
 */
export async function supersedePlanPromotionsOfSet(
  tx: Tx, gymId: string, productSetId: number, actor: string | null,
): Promise<void> {
  await tx.query(
    `UPDATE plan_promotion_snapshots pps
       JOIN product_set_plan_snapshots j ON j.plan_snapshot_id = pps.plan_snapshot_id AND j.product_set_id = ?
        SET pps.status = 'superseded', pps.modified_at = UTC_TIMESTAMP(), pps.modified_by = ?
      WHERE pps.gym_id = ? AND pps.status = 'applied'
        AND NOT EXISTS (SELECT 1 FROM product_set_plan_snapshots o
                         WHERE o.plan_snapshot_id = pps.plan_snapshot_id AND o.product_set_id <> j.product_set_id)`,
    [productSetId, actor, gymId]);
}

/**
 * #3026 stage 3c-3 — the same for an assignment that was superseded: its standing applications on
 * the snapshots no running or in-flight Product Set links.
 */
export async function supersedePlanPromotionsOfAssignment(
  tx: Tx, gymId: string, userMembershipId: number, actor: string | null,
): Promise<void> {
  await tx.query(
    `UPDATE plan_promotion_snapshots pps
       JOIN plan_snapshots s ON s.id = pps.plan_snapshot_id AND s.gym_id = pps.gym_id
        SET pps.status = 'superseded', pps.modified_at = UTC_TIMESTAMP(), pps.modified_by = ?
      WHERE pps.gym_id = ? AND s.source_user_membership_id = ? AND pps.status = 'applied'
        AND NOT EXISTS (SELECT 1 FROM product_set_plan_snapshots o
                          JOIN product_sets ops ON ops.id = o.product_set_id
                         WHERE o.plan_snapshot_id = pps.plan_snapshot_id
                           AND ops.status IN ('active', 'in_cart', 'pending_payment'))`,
    [actor, gymId, userMembershipId]);
}

/** A Draft confirmed: the snapshot the application was agreed with, taken from the Promotion as it stands. */
export async function recordPlanPromotionConfirmed(
  tx: Tx, gymId: string, applicationId: number, snapshotJson: string | null,
): Promise<void> {
  await tx.query(
    `UPDATE plan_promotion_snapshots
        SET snapshot = ?, snapshot_confirmed_at = COALESCE(snapshot_confirmed_at, UTC_TIMESTAMP()), modified_at = UTC_TIMESTAMP()
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
