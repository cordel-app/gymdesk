/**
 * #1865 stage 2 — every purchase of a recurring Product is its own line.
 *
 * Migration 248 allowed one open recurring line per Product and ProductSet
 * version (`ums_one_open_per_set_item` over the generated `open_set_service_key`),
 * which is why a repeat purchase used to be merged into the first line as a
 * quantity. A second purchase now keeps its own price, discount, schedule and
 * lifecycle, so the index and its column go.
 *
 * What replaces them is an identity that survives versioning: `line_ref` is set
 * to the line's own id when the line is first written and copied unchanged when
 * a version is cloned, so the same purchase is recognised across versions (the
 * legacy removal route and the "Review your changes" diff address it by this,
 * not by Product). It is NULL on every row written before this migration, which
 * keeps meaning "one line per Product": readers fall back to the Product for it.
 */

const TABLE = 'member_products_recurrent_snapshot';

async function hasIndex(knex, table, name) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1`,
    [table, name]);
  return rows.length > 0;
}

exports.up = async (knex) => {
  if (await hasIndex(knex, TABLE, 'ums_one_open_per_set_item')) {
    await knex.raw(`ALTER TABLE ${TABLE} DROP INDEX ums_one_open_per_set_item`);
  }
  if (await knex.schema.hasColumn(TABLE, 'open_set_service_key')) {
    await knex.raw(`ALTER TABLE ${TABLE} DROP COLUMN open_set_service_key`);
  }
  if (!(await knex.schema.hasColumn(TABLE, 'line_ref'))) {
    await knex.raw(`ALTER TABLE ${TABLE} ADD COLUMN line_ref INT UNSIGNED NULL`);
    await knex.raw(`ALTER TABLE ${TABLE} ADD INDEX ${TABLE}_line_ref_idx (product_set_id, line_ref)`);
  }
};

exports.down = async (knex) => {
  if (await hasIndex(knex, TABLE, `${TABLE}_line_ref_idx`)) {
    await knex.raw(`ALTER TABLE ${TABLE} DROP INDEX ${TABLE}_line_ref_idx`);
  }
  if (await knex.schema.hasColumn(TABLE, 'line_ref')) {
    await knex.raw(`ALTER TABLE ${TABLE} DROP COLUMN line_ref`);
  }
  // The one-open-line-per-Product index is not recreated: independent lines of
  // one Product may exist by now and the index would refuse them.
};
