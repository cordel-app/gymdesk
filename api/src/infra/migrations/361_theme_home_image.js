/**
 * #2287 — a Theme's Home Image: the banner background of the Admin Home
 * Dashboard header. One nullable column holding the object key of
 * `<theme folder>/home/home.webp`; the public `home_image_url` is derived from
 * the key at read time (as `logo_symbol_object_key`, migration 350). No
 * backfill: a Theme with no Home Image keeps the exercise-of-the-day fallback.
 */

const TABLE = 'themes';
const COLUMN = 'home_image_object_key';

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
