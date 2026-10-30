/**
 * #2157 — a Theme's logo symbol (the symbol-only logo that is also its favicon).
 *
 * One nullable column, the object key of `logo_symbol.webp` beside `logo.<ext>`
 * in the theme's own `logo/` folder. As with `logo_object_key` (migration 180)
 * the public `logo_symbol_url` is derived from the key at read time, never
 * stored, so a change of R2 endpoint cannot leave a stale URL behind.
 *
 * No backfill and `logo_url` / `logo_object_key` are untouched: a Theme with no
 * symbol keeps working exactly as before.
 */

const TABLE = 'themes';
const COLUMN = 'logo_symbol_object_key';

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn(TABLE, COLUMN))) {
    await knex.raw(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} VARCHAR(512) NULL`);
  }
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn(TABLE, COLUMN)) {
    await knex.raw(`ALTER TABLE ${TABLE} DROP COLUMN ${COLUMN}`);
  }
};
