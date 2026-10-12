/**
 * #1420 stage 1: an exercise has a male and a female image and a male and a
 * female video, each independent of the others.
 *
 * Only the master references are stored. The 256x256 thumbnail of an image, and
 * the WebP preview (1080 master + 256 thumbnail) of a video, are derived from the
 * master URL by the documented naming convention (`domain/exerciseGenderMedia.ts`),
 * so no thumbnail column exists (the answer on the ticket: do not invent fields).
 *
 * Nothing is migrated or deleted here. The legacy `image_url`,
 * `image_thumbnail_url`, `video_url` and `video_thumbnail_url` stay in place and
 * keep working until the last stage moves every consumer onto the new columns and
 * drops them; the product owner confirmed the existing exercise media is test
 * data, so that stage does not carry it over.
 */
exports.up = async function up(knex) {
  await knex.raw(`
    ALTER TABLE exercises
      ADD COLUMN image_male_url VARCHAR(1024) NULL,
      ADD COLUMN image_female_url VARCHAR(1024) NULL,
      ADD COLUMN video_male_url VARCHAR(1024) NULL,
      ADD COLUMN video_female_url VARCHAR(1024) NULL
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    ALTER TABLE exercises
      DROP COLUMN image_male_url,
      DROP COLUMN image_female_url,
      DROP COLUMN video_male_url,
      DROP COLUMN video_female_url
  `);
};
