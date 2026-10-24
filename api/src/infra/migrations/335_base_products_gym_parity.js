/**
 * #2009 stage 1 — Base Products carry the same applicable fields as a gym
 * Product, so a later import can be a 1:1 copy (stage 2).
 *
 * Additive only: nothing existing is changed, rewritten or backfilled.
 *  - `description` (VARCHAR 500), `notes` and `package_information` (TEXT):
 *    the same text fields `products` holds, same types.
 *  - `image_url` / `image_thumbnail_url` (VARCHAR 1024): the Product image
 *    pair (#1715), copied by reference on import like Duplicate does.
 *  - `tax_behavior` ('inclusive' | 'exclusive', default 'inclusive'): a
 *    behaviour only. A tax rate id is per gym and is never stored on a
 *    template; the gym's system rate is applied at import.
 *
 * Gym-specific data (`gym_id`, tax rate ids, actors, `is_system`,
 * `base_product_id`) is deliberately not added. Each column is guarded on its
 * own statement because MySQL commits DDL implicitly.
 */

const TABLE = 'base_products';

const COLUMNS = [
  ['description', 'VARCHAR(500) NULL'],
  ['notes', 'TEXT NULL'],
  ['package_information', 'TEXT NULL'],
  ['tax_behavior', "VARCHAR(20) NOT NULL DEFAULT 'inclusive'"],
  ['image_url', 'VARCHAR(1024) NULL'],
  ['image_thumbnail_url', 'VARCHAR(1024) NULL'],
];

exports.up = async (knex) => {
  for (const [column, ddl] of COLUMNS) {
    if (!(await knex.schema.hasColumn(TABLE, column))) {
      await knex.raw(`ALTER TABLE ${TABLE} ADD COLUMN ${column} ${ddl}`);
    }
  }
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'chk_base_products_tax_behavior'`,
    [TABLE],
  );
  if (!rows.length) {
    await knex.raw(
      `ALTER TABLE ${TABLE} ADD CONSTRAINT chk_base_products_tax_behavior CHECK (tax_behavior IN ('inclusive','exclusive'))`,
    );
  }
};

exports.down = async () => {};
