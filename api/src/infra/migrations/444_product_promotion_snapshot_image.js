/**
 * #2624 stage 5 — a Promotion applied to a Product freezes its image like the rest of its snapshot.
 *
 * product_promotion_snapshots gains `promotion_image_url` / `promotion_image_thumbnail_url` (nullable), written
 * with the row by the two writers (a purchase's `insertPurchasePromotion()`, a recurring line's sync) from the
 * Promotion at that moment and never moved after. Existing rows are filled once from the live Promotion (the
 * only image they can have), so a saved Product reads the same picture it was applied with.
 * Additive and safe to re-run.
 */
async function hasColumn(knex, name) {
  return knex.schema.hasColumn('product_promotion_snapshots', name);
}

exports.up = async function up(knex) {
  if (!(await hasColumn(knex, 'promotion_image_url'))) {
    await knex.raw('ALTER TABLE product_promotion_snapshots ADD COLUMN promotion_image_url VARCHAR(1024) NULL');
  }
  if (!(await hasColumn(knex, 'promotion_image_thumbnail_url'))) {
    await knex.raw('ALTER TABLE product_promotion_snapshots ADD COLUMN promotion_image_thumbnail_url VARCHAR(1024) NULL');
  }
  await knex.raw(`
    UPDATE product_promotion_snapshots pp
      JOIN promotions pr ON pr.id = pp.promotion_id
       SET pp.promotion_image_url = COALESCE(pp.promotion_image_url, pr.image_url),
           pp.promotion_image_thumbnail_url = COALESCE(pp.promotion_image_thumbnail_url, pr.image_thumbnail_url)
     WHERE pp.promotion_image_url IS NULL AND pr.image_url IS NOT NULL`);
};

exports.down = async function down(knex) {
  if (await hasColumn(knex, 'promotion_image_thumbnail_url')) {
    await knex.raw('ALTER TABLE product_promotion_snapshots DROP COLUMN promotion_image_thumbnail_url');
  }
  if (await hasColumn(knex, 'promotion_image_url')) {
    await knex.raw('ALTER TABLE product_promotion_snapshots DROP COLUMN promotion_image_url');
  }
};
