/**
 * #1722 — a Personal Goal's image moves onto the shared WebP pipeline (the
 * Membership Plan's, #1514; a Nutrition Goal's, #1623): a 1080 × 1080 WebP master
 * in `image_url` and a 256 × 256 WebP thumbnail in the new `image_thumbnail_url`.
 *
 * NULL is what every existing goal means for the thumbnail: no backfill, no
 * CHECK, and no existing object is touched. A goal whose `image_url` still holds
 * a pre-#1722 PNG keeps rendering from it (the list falls back to the master);
 * replacing that image is what moves it onto the new keys.
 */

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('personal_goals', 'image_thumbnail_url'))) {
    await knex.raw('ALTER TABLE personal_goals ADD COLUMN image_thumbnail_url VARCHAR(1024) NULL');
  }
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('personal_goals', 'image_thumbnail_url')) {
    await knex.raw('ALTER TABLE personal_goals DROP COLUMN image_thumbnail_url');
  }
};
