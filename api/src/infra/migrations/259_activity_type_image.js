/**
 * #1373 — an Activity Type carries an image: `activity_types.image_url`.
 *
 * The URL, not the key, with the name and width every other media reference has
 * (`members` 253, `personal_goals` 225): `api/src/domain/activityImages.ts` is
 * the one place the key is built, `POST`/`DELETE /activity-types/:id/image` the
 * only writers. NULL is what every existing row means ("no image"), so there is
 * no backfill and no CHECK (`ADD CONSTRAINT` would rebuild the table under
 * `ALGORITHM=COPY` for nothing). `down()` forgets which object each row pointed
 * at; the objects stay in the bucket.
 *
 * Guarded on its own statement: MySQL commits DDL implicitly, so a crash must
 * not make a re-run skip it.
 */

const TABLE = 'activity_types';
const COLUMN = 'image_url';

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn(TABLE, COLUMN))) {
    await knex.raw(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} VARCHAR(1024) NULL`);
  }
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn(TABLE, COLUMN)) {
    await knex.raw(`ALTER TABLE ${TABLE} DROP COLUMN ${COLUMN}`);
  }
};
