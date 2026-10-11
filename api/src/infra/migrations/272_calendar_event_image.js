/**
 * #1382 — a Calendar Event may carry its own image: `calendar_events.image_url`.
 *
 * NULL is what every existing row means ("no override"): the event then shows
 * its Activity Type's image (`activity_types.image_url`, #1373). The URL, not
 * the key, with the name and width every other media reference has.
 * `api/src/domain/calendarEventImages.ts` is the one place the key is built and
 * `POST`/`DELETE /class-sessions/:id/image` the only writers. No backfill and
 * no CHECK (`ADD CONSTRAINT` would rebuild the table under `ALGORITHM=COPY`).
 * `down()` forgets which object each row pointed at; the objects stay in the bucket.
 *
 * Guarded on its own statement: MySQL commits DDL implicitly, so a crash must
 * not make a re-run skip it.
 */

const TABLE = 'calendar_events';
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
