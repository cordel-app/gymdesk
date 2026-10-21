/**
 * #1863 — a Promotion may only be applied to a Membership Plan or a recurring
 * Product that was added in the Draft ProductSet itself, never to one the Draft
 * inherited from the previous Active version.
 *
 * `is_inherited` is written by the clone (`cloneConfiguration()`): 1 on every
 * copied row, 0 on a row added in the Draft. Every existing row is 0 — nothing
 * written before this migration is made ineligible, and nothing is backfilled:
 * a committed version is never edited, so the flag only matters on a Draft.
 * No CHECK (ALGORITHM=COPY on busy tables).
 */

const TABLES = ['product_set_plan_snapshots', 'member_products_recurrent_snapshot'];

exports.up = async (knex) => {
  for (const table of TABLES) {
    if (!(await knex.schema.hasColumn(table, 'is_inherited'))) {
      await knex.raw(`ALTER TABLE ${table} ADD COLUMN is_inherited TINYINT(1) NOT NULL DEFAULT 0`);
    }
  }
};

exports.down = async (knex) => {
  for (const table of TABLES) {
    if (await knex.schema.hasColumn(table, 'is_inherited')) {
      await knex.raw(`ALTER TABLE ${table} DROP COLUMN is_inherited`);
    }
  }
};
