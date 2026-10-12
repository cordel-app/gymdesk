/**
 * #1420 (last stage): drops the legacy exercise media columns.
 *
 * `image_url` / `image_thumbnail_url` (migration 187) and `video_url` /
 * `video_thumbnail_url` (migration 188) held the old 2048 PNG pair and the MP4
 * with its 512 PNG poster. The gender-specific masters added by migration 276
 * replace them, every consumer now reads those, and the product owner confirmed
 * the existing exercise media is test data — so **nothing is carried over** and
 * there is no backfill.
 *
 * The objects themselves are removed from the bucket by an operator script
 * (`npm run exercises:purge-legacy-media`, `.github/workflows/exercises-purge-
 * legacy-media.yml`), which decides from object keys alone and therefore runs
 * before or after this migration. A migration cannot talk to R2.
 *
 * `down` re-adds the columns empty: the data is not recoverable by design.
 */
exports.up = async function up(knex) {
  await knex.raw(`
    ALTER TABLE exercises
      DROP COLUMN image_url,
      DROP COLUMN image_thumbnail_url,
      DROP COLUMN video_url,
      DROP COLUMN video_thumbnail_url
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    ALTER TABLE exercises
      ADD COLUMN image_url VARCHAR(1024) NULL,
      ADD COLUMN image_thumbnail_url VARCHAR(1024) NULL,
      ADD COLUMN video_url VARCHAR(1024) NULL,
      ADD COLUMN video_thumbnail_url VARCHAR(1024) NULL
  `);
};
