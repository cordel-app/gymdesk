/**
 * #3026 stage 3d-3a: a Product-target Promotion application states its own confirmation on its
 * Product snapshot row, and its id space is kept clear of the legacy one.
 *
 * Schema preparation for moving Product-target applications off `user_membership_promotions`
 * (stage 3d-3b moves the readers, 3d-3c the writers, 3d-3d drops the table). Nothing reads either
 * change yet.
 *
 * - `product_promotion_snapshots.snapshot_confirmed_at`: the moment a line-owned application's
 *   snapshot was taken (Save & Pay or the free commit, #2833). Until now only the legacy row carried
 *   it, so a reader telling a Draft's reference from a confirmed application had to join that table.
 *   It is dual-written by `syncProductSnapshotsOfVersion()`; the backfill copies it from the legacy
 *   row (`source_application_id`). A purchase's Promotion row (`source_purchase_promotion_id`) is
 *   frozen when the purchase is written and is never a reference, so it is left NULL and nothing
 *   asks it.
 *   So a NULL is a Draft reference only on a line-owned row (`product_periodical_snapshot_id` set):
 *   a reader added later asks both. Every line-owned row still has its legacy twin until stage
 *   3d-3c, so the twin's value is the whole backfill; stage 3d-3c's writer stamps it itself.
 * - The table's AUTO_INCREMENT is put above every legacy application id (with a headroom for rows
 *   written while this deploys), migration 449's device: from stage 3d-3c an application written
 *   with no legacy twin is identified by its own id (`COALESCE(source_application_id, id)`), which
 *   must never be read as a legacy application's.
 *
 * Additive and re-entrant; `down` drops the column (an AUTO_INCREMENT is never lowered).
 */
const HEADROOM = 100000;

exports.up = async (knex) => {
  const has = await knex.schema.hasColumn('product_promotion_snapshots', 'snapshot_confirmed_at');
  if (!has) {
    await knex.schema.alterTable('product_promotion_snapshots', (t) => {
      t.datetime('snapshot_confirmed_at').nullable();
    });
  }
  await knex.raw(
    `UPDATE product_promotion_snapshots pp
       JOIN user_membership_promotions ump ON ump.id = pp.source_application_id
        SET pp.snapshot_confirmed_at = ump.snapshot_confirmed_at
      WHERE pp.snapshot_confirmed_at IS NULL AND ump.snapshot_confirmed_at IS NOT NULL`);

  const [rows] = await knex.raw(
    `SELECT GREATEST(
              (SELECT COALESCE(MAX(id), 0) FROM user_membership_promotions),
              (SELECT COALESCE(MAX(id), 0) FROM product_promotion_snapshots),
              (SELECT COALESCE(MAX(source_application_id), 0) FROM product_promotion_snapshots)) AS top`);
  const next = Number(rows[0].top) + HEADROOM;
  await knex.raw(`ALTER TABLE product_promotion_snapshots AUTO_INCREMENT = ${next}`);
};

exports.down = async (knex) => {
  const has = await knex.schema.hasColumn('product_promotion_snapshots', 'snapshot_confirmed_at');
  if (has) {
    await knex.schema.alterTable('product_promotion_snapshots', (t) => {
      t.dropColumn('snapshot_confirmed_at');
    });
  }
};
