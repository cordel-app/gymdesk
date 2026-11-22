/**
 * #3026 stage 3d-3b: a line-owned Product-target Promotion application names the Product Set it
 * belongs to on its Product snapshot row.
 *
 * Since #2126 stage 5c-2c-2 a recurring line unchanged across versions is one snapshot linked by
 * each of them, while each version still holds its own copy of the line's applications (a Draft can
 * add or remove a Promotion on a line it shares with the Active set without owning the line). So the
 * rows of `product_promotion_snapshots` on one line can belong to different Product Sets, and a
 * reader asking "the applications of this set" could only tell them apart through the legacy
 * `user_membership_promotions.product_set_id`. This column is that answer on the snapshot row, which
 * is what lets stage 3d-3b move the readers off the legacy table.
 *
 * It is the application's owner, not the snapshot's link to a set (that stays the
 * `product_set_periodical_snapshots` junction): a purchase's Promotion row
 * (`source_purchase_promotion_id`) belongs to no Product Set and keeps NULL. Dual-written by
 * `syncProductSnapshotsOfVersion()`; the backfill copies it from the legacy row
 * (`source_application_id`). ON DELETE CASCADE, as the legacy row's own FK: an application goes with
 * its set.
 *
 * Additive and re-entrant; `down` drops the column with its key and FK.
 */
exports.up = async (knex) => {
  const has = await knex.schema.hasColumn('product_promotion_snapshots', 'product_set_id');
  if (!has) {
    await knex.raw(`
      ALTER TABLE product_promotion_snapshots
        ADD COLUMN product_set_id INT UNSIGNED NULL AFTER member_id,
        ADD KEY prps_set_index (product_set_id),
        ADD CONSTRAINT prps_set_fk FOREIGN KEY (product_set_id) REFERENCES product_sets (id) ON DELETE CASCADE`);
  }
  await knex.raw(
    `UPDATE product_promotion_snapshots pp
       JOIN user_membership_promotions ump ON ump.id = pp.source_application_id
        SET pp.product_set_id = ump.product_set_id
      WHERE pp.product_set_id IS NULL AND ump.product_set_id IS NOT NULL`);
};

exports.down = async (knex) => {
  const has = await knex.schema.hasColumn('product_promotion_snapshots', 'product_set_id');
  if (has) {
    await knex.raw(`
      ALTER TABLE product_promotion_snapshots
        DROP FOREIGN KEY prps_set_fk,
        DROP KEY prps_set_index,
        DROP COLUMN product_set_id`);
  }
};
