/**
 * #1422 — drop `exercises.notes_default` (the "Default notes" field).
 *
 * Migration 036 (#55) added it with the other structured defaults. The ticket
 * removes it from Base and Gym Exercises alike: the editor, the read-only views,
 * the create/update/duplicate/clone/import paths and the API all stop naming it,
 * and the values it held are discarded. `min_reps_default`, `max_reps_default`,
 * `sets_default` and `rest_default_seconds` are untouched.
 *
 * `down()` restores the empty nullable column; the dropped text is not recoverable.
 *
 * Guarded on its own statement: MySQL commits DDL implicitly, so a crash must
 * not make a re-run skip it.
 */

const TABLE = 'exercises';
const COLUMN = 'notes_default';

exports.up = async (knex) => {
  if (await knex.schema.hasColumn(TABLE, COLUMN)) {
    await knex.raw(`ALTER TABLE ${TABLE} DROP COLUMN ${COLUMN}`);
  }
};

exports.down = async (knex) => {
  if (!(await knex.schema.hasColumn(TABLE, COLUMN))) {
    await knex.raw(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} TEXT NULL`);
  }
};
