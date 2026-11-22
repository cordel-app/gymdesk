import type { Tx } from '../infra/db';
import { draftReferenceApplicationSql } from '../domain/draftPromotionApplication';

type Conn = Pick<Tx, 'query'>;

/**
 * #3026 stage 3d-3c — a Product-target Promotion application owned by a recurring line is written
 * onto the line's Product snapshot (`product_promotion_snapshots`, with the Products it froze in
 * `product_promotion_grant_snapshots`) by the writer that applies, removes, confirms, copies or moves
 * it, in the same transaction. No `user_membership_promotions` row is written for it any more, and
 * nothing derives these rows from that table (`syncProductSnapshotsOfVersion()` no longer reads it).
 *
 * The plan-side counterpart is `plan-promotion-writer.ts`. An application's id is
 * `COALESCE(source_application_id, id)`: a row written here has no legacy twin, so its own id (above
 * every legacy application id since migration 452) is the application's. A row is owned by the
 * Product Set named in `product_set_id` (migration 454): versions sharing a line each hold their own.
 */

/** The SQL spelling of a Product-target application's id on its Product snapshot row. */
export function productApplicationIdSql(alias: string): string {
  return `COALESCE(${alias}.source_application_id, ${alias}.id)`;
}

/** The Product snapshot row of a recurring line the set links, by the line's id (`source_id`). */
async function lineSnapshotOf(tx: Conn, gymId: string, productSetId: number, lineId: number): Promise<number | null> {
  const { rows } = await tx.query<{ id: number }>(
    `SELECT s.id FROM product_set_periodical_snapshots lnk
       JOIN product_periodical_snapshots s ON s.id = lnk.product_periodical_snapshot_id
      WHERE s.source_id = ? AND s.gym_id = ? AND lnk.product_set_id = ?
      LIMIT 1`,
    [lineId, gymId, productSetId]);
  return rows[0] ? Number(rows[0].id) : null;
}

/** The standing applications (`applied`) this set holds on one of its lines. */
export async function standingLineApplications(
  tx: Conn, gymId: string, productSetId: number, lineId: number,
): Promise<Array<{ id: number; promotion_id: number }>> {
  const { rows } = await tx.query<{ id: number; promotion_id: number }>(
    `SELECT ${productApplicationIdSql('pp')} AS id, pp.promotion_id
       FROM product_promotion_snapshots pp
       JOIN product_periodical_snapshots par ON par.id = pp.product_periodical_snapshot_id
      WHERE pp.gym_id = ? AND pp.product_set_id = ? AND par.source_id = ? AND pp.status = 'applied'`,
    [gymId, productSetId, lineId]);
  return rows.map((r) => ({ id: Number(r.id), promotion_id: Number(r.promotion_id) }));
}

/**
 * Applies a Product Promotion to one line of a Draft as a **reference** (no snapshot, not confirmed,
 * #2833) and answers the application's id. The frozen name and images are left to the confirmation;
 * until then every reader resolves the live Promotion.
 */
export async function insertProductPromotionReference(
  tx: Conn, gymId: string, productSetId: number, lineId: number, promotionId: number, actor: string | null,
): Promise<number | null> {
  const snapshotId = await lineSnapshotOf(tx, gymId, productSetId, lineId);
  if (snapshotId == null) return null;
  const { insertId } = await tx.query(
    `INSERT INTO product_promotion_snapshots
       (gym_id, member_id, product_set_id, product_periodical_snapshot_id, source_application_id, promotion_id,
        promotion_name, status, snapshot, applied_at, created_at, created_by)
     SELECT ps.gym_id, ps.owner_member_id, ps.id, ?, NULL, pr.id, pr.name, 'applied', NULL,
            UTC_TIMESTAMP(), UTC_TIMESTAMP(), ?
       FROM product_sets ps JOIN promotions pr ON pr.id = ? AND pr.gym_id = ps.gym_id
      WHERE ps.id = ? AND ps.gym_id = ?`,
    [snapshotId, actor, promotionId, productSetId, gymId]);
  return insertId ? Number(insertId) : null;
}

/**
 * Removes a Product Promotion from the lines of a Draft: a reference is deleted (with any earlier
 * removed reference of it, #2880), a confirmed application the Draft carries is revoked and kept.
 * Answers what it did.
 */
export async function removeProductPromotion(
  tx: Conn, gymId: string, productSetId: number, promotionId: number, actor: string | null,
): Promise<'deleted' | 'revoked' | 'none'> {
  const { rows: refs } = await tx.query<{ id: number }>(
    `SELECT pp.id FROM product_promotion_snapshots pp
      WHERE pp.gym_id = ? AND pp.product_set_id = ? AND pp.promotion_id = ? AND pp.status = 'applied'
        AND pp.product_periodical_snapshot_id IS NOT NULL AND ${draftReferenceApplicationSql('pp')}
      FOR UPDATE`,
    [gymId, productSetId, promotionId]);
  if (refs.length > 0) {
    await tx.query(
      `DELETE FROM product_promotion_snapshots
        WHERE gym_id = ? AND product_set_id = ? AND promotion_id = ? AND product_periodical_snapshot_id IS NOT NULL
          AND status IN ('applied', 'revoked') AND snapshot_confirmed_at IS NULL`,
      [gymId, productSetId, promotionId]);
    return 'deleted';
  }
  const { rowCount } = await tx.query(
    `UPDATE product_promotion_snapshots
        SET status = 'revoked', revoked_at = UTC_TIMESTAMP(), modified_at = UTC_TIMESTAMP(), modified_by = ?
      WHERE gym_id = ? AND product_set_id = ? AND promotion_id = ? AND status = 'applied'
        AND product_periodical_snapshot_id IS NOT NULL`,
    [actor, gymId, productSetId, promotionId]);
  return rowCount > 0 ? 'revoked' : 'none';
}

/** Deletes one application of a Draft by its id; answers whether a row went. */
export async function deleteProductApplication(
  tx: Conn, gymId: string, productSetId: number, applicationId: number,
): Promise<boolean> {
  const { rowCount } = await tx.query(
    `DELETE FROM product_promotion_snapshots
      WHERE gym_id = ? AND product_set_id = ? AND product_periodical_snapshot_id IS NOT NULL
        AND ${productApplicationIdSql('product_promotion_snapshots')} = ?`,
    [gymId, productSetId, applicationId]);
  return rowCount > 0;
}

/** Every application (any status) the set holds on one line, for an edit that re-selects them. */
export async function lineApplications(
  tx: Conn, gymId: string, productSetId: number, lineId: number,
): Promise<Array<{ id: number; promotion_id: number; status: string }>> {
  const { rows } = await tx.query<any>(
    `SELECT ${productApplicationIdSql('pp')} AS id, pp.promotion_id, pp.status
       FROM product_promotion_snapshots pp
       JOIN product_periodical_snapshots par ON par.id = pp.product_periodical_snapshot_id
      WHERE pp.gym_id = ? AND pp.product_set_id = ? AND par.source_id = ?
      ORDER BY pp.id`,
    [gymId, productSetId, lineId]);
  return rows.map((r: any) => ({ id: Number(r.id), promotion_id: Number(r.promotion_id), status: String(r.status) }));
}

/** A superseded set's standing Product applications are history. */
export async function supersedeProductPromotionsOfSet(
  tx: Conn, gymId: string, productSetId: number, actor: string | null,
): Promise<void> {
  await tx.query(
    `UPDATE product_promotion_snapshots
        SET status = 'superseded', modified_at = UTC_TIMESTAMP(), modified_by = ?
      WHERE gym_id = ? AND product_set_id = ? AND status = 'applied' AND product_periodical_snapshot_id IS NOT NULL`,
    [actor, gymId, productSetId]);
}

/** A copy-on-write of a line takes the set's applications on it along (`ownRecurringLine()`). */
export async function moveProductApplicationsToLine(
  tx: Conn, gymId: string, productSetId: number, fromSnapshotId: number, toSnapshotId: number,
): Promise<void> {
  await tx.query(
    `UPDATE product_promotion_snapshots SET product_periodical_snapshot_id = ?
      WHERE gym_id = ? AND product_set_id = ? AND product_periodical_snapshot_id = ?`,
    [toSnapshotId, gymId, productSetId, fromSnapshotId]);
}

const GRANT_KINDS: Array<{ kind: string; source: string }> = [
  { kind: 'session', source: 'promotion_session' },
  { kind: 'oneoff', source: 'promotion_oneoff' },
  { kind: 'periodical', source: 'promotion_periodical' },
];

/**
 * Confirms the Product references of a Draft (#2833): a removed reference is deleted, each standing
 * one takes the snapshot the caller builds from the Promotion as it stands, its frozen name and
 * images, and the Products it grants frozen from the live benefit tables, and is stamped confirmed.
 * A confirmed application (a copy of the predecessor's) is never touched. Answers how many rows it
 * wrote or deleted.
 */
export async function confirmProductPromotionReferences(
  tx: Conn, gymId: string, productSetId: number,
  buildSnapshot: (promotionId: number) => Promise<unknown | null>,
): Promise<number> {
  const { rowCount: discarded } = await tx.query(
    `DELETE FROM product_promotion_snapshots
      WHERE gym_id = ? AND product_set_id = ? AND product_periodical_snapshot_id IS NOT NULL
        AND status = 'revoked' AND snapshot_confirmed_at IS NULL`,
    [gymId, productSetId]);
  const { rows } = await tx.query<{ id: number; promotion_id: number }>(
    `SELECT id, promotion_id FROM product_promotion_snapshots
      WHERE gym_id = ? AND product_set_id = ? AND product_periodical_snapshot_id IS NOT NULL
        AND status = 'applied' AND snapshot_confirmed_at IS NULL
      ORDER BY id FOR UPDATE`,
    [gymId, productSetId]);
  for (const app of rows) {
    const snapshot = await buildSnapshot(Number(app.promotion_id)) as Record<string, unknown> | null;
    await tx.query(
      `UPDATE product_promotion_snapshots pp
         JOIN promotions pr ON pr.id = pp.promotion_id
          SET pp.snapshot = ?, pp.snapshot_confirmed_at = UTC_TIMESTAMP(), pp.modified_at = UTC_TIMESTAMP(),
              pp.promotion_name = COALESCE(?, pr.name),
              pp.promotion_image_url = COALESCE(?, pr.image_url),
              pp.promotion_image_thumbnail_url = COALESCE(?, pr.image_thumbnail_url)
        WHERE pp.id = ? AND pp.gym_id = ? AND pp.snapshot_confirmed_at IS NULL`,
      [snapshot != null ? JSON.stringify(snapshot) : null,
        (snapshot?.name as string | undefined) ?? null,
        (snapshot?.image_url as string | undefined) ?? null,
        (snapshot?.image_thumbnail_url as string | undefined) ?? null,
        app.id, gymId]);
    await tx.query(
      'DELETE FROM product_promotion_grant_snapshots WHERE gym_id = ? AND product_promotion_snapshot_id = ?',
      [gymId, app.id]);
    for (const { kind, source } of GRANT_KINDS) {
      await tx.query(
        `INSERT INTO product_promotion_grant_snapshots
           (gym_id, product_promotion_snapshot_id, grant_kind, source_id, product_id, product_name, quantity,
            item_type, item_billing_frequency, unit_price, currency, \`action\`, \`value\`, requirement)
         SELECT ?, ?, '${kind}', NULL, b.product_id, COALESCE(gc.name, ct.name, CONCAT('Product #', gc.id)),
                b.quantity, COALESCE(gc.type, 'other'), gc.billing_frequency, COALESCE(gc.amount, 0), gc.currency,
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

/**
 * Copies the line-owned Product applications of one set onto another (a clone or a merge): each
 * follows its line into the successor (matched on `line_ref`), keeping its status, confirmation,
 * snapshot and the Products it froze; an application whose line is not part of the successor is
 * left behind. The copies are the successor's own rows with no legacy twin.
 */
export async function copyProductApplications(
  tx: Conn, gymId: string, fromSetId: number, toSetId: number,
): Promise<void> {
  const { rows } = await tx.query<any>(
    `SELECT pp.id, pp.product_periodical_snapshot_id
       FROM product_promotion_snapshots pp
       JOIN promotions pr ON pr.id = pp.promotion_id AND pr.applies_to = 'product'
      WHERE pp.gym_id = ? AND pp.product_set_id = ? AND pp.product_periodical_snapshot_id IS NOT NULL
      ORDER BY pp.id`,
    [gymId, fromSetId]);
  for (const app of rows) {
    const { rows: lines } = await tx.query<{ id: number }>(
      `SELECT n.id FROM product_periodical_snapshots o
         JOIN product_set_periodical_snapshots nl ON nl.product_set_id = ?
         JOIN product_periodical_snapshots n
           ON n.id = nl.product_periodical_snapshot_id AND n.gym_id = o.gym_id
          AND COALESCE(n.line_ref, n.source_id) = COALESCE(o.line_ref, o.source_id)
        WHERE o.id = ? AND o.gym_id = ? ORDER BY n.source_id LIMIT 1`,
      [toSetId, Number(app.product_periodical_snapshot_id), gymId]);
    if (!lines[0]) continue; // the line is not part of the successor, nor is its application
    const { insertId } = await tx.query(
      `INSERT INTO product_promotion_snapshots
         (gym_id, member_id, product_set_id, product_periodical_snapshot_id, source_application_id, promotion_id,
          promotion_name, status, benefit_action, benefit_value, duration_cycles, regular_amount, final_amount,
          snapshot, applied_at, applied_by, consumed_at, revoked_at, created_at, created_by, modified_at, modified_by,
          promotion_image_url, promotion_image_thumbnail_url, snapshot_confirmed_at)
       SELECT pp.gym_id, ps.owner_member_id, ps.id, ?, NULL, pp.promotion_id,
              pp.promotion_name, pp.status, pp.benefit_action, pp.benefit_value, pp.duration_cycles, pp.regular_amount,
              pp.final_amount, pp.snapshot, pp.applied_at, pp.applied_by, pp.consumed_at, pp.revoked_at,
              pp.created_at, pp.created_by, pp.modified_at, pp.modified_by,
              pp.promotion_image_url, pp.promotion_image_thumbnail_url, pp.snapshot_confirmed_at
         FROM product_promotion_snapshots pp JOIN product_sets ps ON ps.id = ? AND ps.gym_id = pp.gym_id
        WHERE pp.id = ? AND pp.gym_id = ?`,
      [Number(lines[0].id), toSetId, Number(app.id), gymId]);
    await tx.query(
      `INSERT INTO product_promotion_grant_snapshots
         (gym_id, product_promotion_snapshot_id, grant_kind, source_id, product_id, product_name, quantity,
          item_type, item_billing_frequency, unit_price, currency, \`action\`, \`value\`, requirement, created_at)
       SELECT gym_id, ?, grant_kind, NULL, product_id, product_name, quantity, item_type, item_billing_frequency,
              unit_price, currency, \`action\`, \`value\`, requirement, created_at
         FROM product_promotion_grant_snapshots
        WHERE gym_id = ? AND product_promotion_snapshot_id = ? ORDER BY id`,
      [Number(insertId), gymId, Number(app.id)]);
  }
}
