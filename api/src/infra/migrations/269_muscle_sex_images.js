/**
 * #1412: a muscle has a male and a female image (each a 1080x1080 master plus a
 * 256x256 thumbnail, WebP), replacing the single pair.
 *
 * The existing single-pair values are discarded rather than carried over: the
 * product owner verified there are no valid muscle images in the bucket (a test
 * environment), so nothing is copied into the male columns and no object is
 * deleted. Every consumer moves to the new columns in the same change, so the
 * legacy `image_url` / `image_thumbnail_url` are dropped here too.
 */
exports.up = async function up(knex) {
  await knex.raw(`
    ALTER TABLE muscles
      ADD COLUMN image_male_url VARCHAR(1024) NULL,
      ADD COLUMN image_male_url_thumbnail VARCHAR(1024) NULL,
      ADD COLUMN image_female_url VARCHAR(1024) NULL,
      ADD COLUMN image_female_url_thumbnail VARCHAR(1024) NULL,
      DROP COLUMN image_url,
      DROP COLUMN image_thumbnail_url
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    ALTER TABLE muscles
      ADD COLUMN image_url VARCHAR(1024) NULL,
      ADD COLUMN image_thumbnail_url VARCHAR(1024) NULL,
      DROP COLUMN image_male_url,
      DROP COLUMN image_male_url_thumbnail,
      DROP COLUMN image_female_url,
      DROP COLUMN image_female_url_thumbnail
  `);
};
