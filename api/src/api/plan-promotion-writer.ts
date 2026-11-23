import type { Tx } from '../infra/db';
import { isPlanSnapshotShared, primaryPlanSnapshotId } from './plan-snapshot-lines';
import { draftReferencePlanPromotionSql } from '../domain/draftPromotionApplication';

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
      WHERE pps.gym_id = ? AND s.assignment_id = ? AND pps.status = 'applied'
        AND NOT EXISTS (SELECT 1 FROM product_set_plan_snapshots o
                          JOIN product_sets ops ON ops.id = o.product_set_id
                         WHERE o.plan_snapshot_id = pps.plan_snapshot_id
                           AND ops.status IN ('active', 'in_cart', 'pending_payment'))`,
    [actor, gymId, userMembershipId]);
}

/* ── #3026 stage 3d-1: the plan snapshot row is the application ─────────────────────────────── */

/**
 * Applies a Membership Plan Promotion to the version's primary plan snapshot as a **reference**
 * (no snapshot, not confirmed, #2833) and answers the row's id, which is the application's. No
 * `user_membership_promotions` row is written for a Plan application any more. The caller owns
 * the snapshot first (`ownPrimaryPlanSnapshot()`).
 */
export async function insertPlanPromotionReference(
  tx: Tx, gymId: string, productSetId: number, promotionId: number, actor: string | null,
  /** #2966 stage 7: a further plan of the set, by its snapshot id; absent = the primary plan. */
  planSnapshotId?: number,
): Promise<number | null> {
  const snapshotId = planSnapshotId ?? await primaryPlanSnapshotId(tx, gymId, productSetId);
  if (snapshotId == null) return null;
  const { insertId } = await tx.query(
    `INSERT INTO plan_promotion_snapshots
       (gym_id, plan_snapshot_id, source_id, promotion_id, status, is_inherited, snapshot,
        applied_at, created_at, created_by)
     VALUES (?, ?, NULL, ?, 'applied', 0, NULL, UTC_TIMESTAMP(), UTC_TIMESTAMP(), ?)`,
    [gymId, snapshotId, promotionId, actor]);
  return Number(insertId);
}

/**
 * Removes a Promotion from the version's own primary plan snapshot: a Draft's reference is deleted
 * (with any earlier removed reference of it, #2880), a confirmed application is revoked and kept.
 * Answers what it did, `none` when the snapshot holds no standing application of that Promotion.
 */
export async function removePlanPromotion(
  tx: Tx, gymId: string, productSetId: number, promotionId: number, actor: string | null,
): Promise<'deleted' | 'revoked' | 'none'> {
  const snapshotId = await primaryPlanSnapshotId(tx, gymId, productSetId);
  if (snapshotId == null) return 'none';
  const { rows: refs } = await tx.query<{ id: number }>(
    `SELECT pps.id FROM plan_promotion_snapshots pps
      WHERE pps.gym_id = ? AND pps.plan_snapshot_id = ? AND pps.promotion_id = ? AND pps.status = 'applied'
        AND ${draftReferencePlanPromotionSql('pps')} FOR UPDATE`,
    [gymId, snapshotId, promotionId]);
  if (refs.length > 0) {
    await tx.query(
      `DELETE FROM plan_promotion_snapshots
        WHERE gym_id = ? AND plan_snapshot_id = ? AND promotion_id = ?
          AND status IN ('applied', 'revoked') AND snapshot_confirmed_at IS NULL`,
      [gymId, snapshotId, promotionId]);
    return 'deleted';
  }
  const { rowCount } = await tx.query(
    `UPDATE plan_promotion_snapshots
        SET status = 'revoked', revoked_at = UTC_TIMESTAMP(), modified_at = UTC_TIMESTAMP(), modified_by = ?
      WHERE gym_id = ? AND plan_snapshot_id = ? AND promotion_id = ? AND status = 'applied'`,
    [actor, gymId, snapshotId, promotionId]);
  return rowCount > 0 ? 'revoked' : 'none';
}

const LIVE_GRANTS: Array<{ source: string; target: string }> = [
  { source: 'promotion_session', target: 'plan_promotion_session_product_snapshots' },
  { source: 'promotion_oneoff', target: 'plan_promotion_oneoff_product_snapshots' },
  { source: 'promotion_periodical', target: 'plan_promotion_periodical_product_snapshots' },
];

/**
 * Confirms the references each of the version's own plan snapshots holds (rows with no legacy twin;
 * the primary plan and, since #2966 stage 7, every further plan added to the cart):
 * each standing one takes the snapshot the caller builds from the Promotion as it stands and its
 * grant rows, frozen from the live benefit tables, and is stamped confirmed; a removed reference is
 * deleted. A snapshot another Product Set links is that set's contract and is left alone. Answers
 * how many rows it wrote or deleted.
 */
export async function confirmPlanPromotionReferences(
  tx: Tx, gymId: string, productSetId: number,
  buildSnapshot: (promotionId: number) => Promise<unknown | null>,
): Promise<number> {
  // #2966 stage 7: every billable plan snapshot of the version, not only the primary one — a further
  // plan staff added to the cart carries its own references, confirmed in the same transaction.
  const { rows: links } = await tx.query<{ plan_snapshot_id: number }>(
    `SELECT j.plan_snapshot_id FROM product_set_plan_snapshots j
       JOIN plan_snapshots s ON s.id = j.plan_snapshot_id
      WHERE j.product_set_id = ? AND s.gym_id = ? AND j.entitlement_only = 0
      ORDER BY j.id`,
    [productSetId, gymId]);
  let written = 0;
  for (const link of links) {
    written += await confirmSnapshotReferences(tx, gymId, productSetId, Number(link.plan_snapshot_id), buildSnapshot);
  }
  return written;
}

async function confirmSnapshotReferences(
  tx: Tx, gymId: string, productSetId: number, snapshotId: number,
  buildSnapshot: (promotionId: number) => Promise<unknown | null>,
): Promise<number> {
  if (await isPlanSnapshotShared(tx, productSetId, snapshotId)) return 0;
  const { rowCount: discarded } = await tx.query(
    `DELETE FROM plan_promotion_snapshots
      WHERE gym_id = ? AND plan_snapshot_id = ? AND source_id IS NULL
        AND status = 'revoked' AND snapshot_confirmed_at IS NULL`,
    [gymId, snapshotId]);
  const { rows } = await tx.query<{ id: number; promotion_id: number }>(
    `SELECT id, promotion_id FROM plan_promotion_snapshots
      WHERE gym_id = ? AND plan_snapshot_id = ? AND source_id IS NULL
        AND status = 'applied' AND snapshot_confirmed_at IS NULL
      ORDER BY id FOR UPDATE`,
    [gymId, snapshotId]);
  for (const app of rows) {
    const snapshot = await buildSnapshot(Number(app.promotion_id));
    await tx.query(
      `UPDATE plan_promotion_snapshots
          SET snapshot = ?, snapshot_confirmed_at = UTC_TIMESTAMP(), modified_at = UTC_TIMESTAMP()
        WHERE id = ? AND gym_id = ? AND snapshot_confirmed_at IS NULL`,
      [snapshot != null ? JSON.stringify(snapshot) : null, app.id, gymId]);
    for (const { source, target } of LIVE_GRANTS) {
      await tx.query(`DELETE FROM ${target} WHERE gym_id = ? AND plan_promotion_snapshot_id = ?`, [gymId, app.id]);
      await tx.query(
        `INSERT INTO ${target}
           (gym_id, plan_promotion_snapshot_id, product_id, product_name, quantity, item_type,
            item_billing_frequency, unit_price, currency, \`action\`, \`value\`, requirement)
         SELECT ?, ?, b.product_id, COALESCE(gc.name, ct.name, CONCAT('Product #', gc.id)), b.quantity,
                COALESCE(gc.type, 'other'), gc.billing_frequency, COALESCE(gc.amount, 0), gc.currency,
                b.\`action\`, b.\`value\`, b.requirement
           FROM ${source} b
           JOIN products gc ON gc.id = b.product_id
           LEFT JOIN charge_types ct ON ct.id = gc.charge_type_id
          WHERE b.promotion_id = ? AND b.gym_id = ?`,
        [gymId, app.id, app.promotion_id, gymId]);
    }
  }
  return rows.length + discarded;
}
