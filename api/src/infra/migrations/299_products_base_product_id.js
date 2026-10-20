/**
 * #1851 — Import System Products: the provenance of a gym's Product.
 *
 * `products.base_product_id` names the `base_products` template a Product was
 * created from (gym creation or the Import System Products action). It is the
 * one record of "already imported", and `UNIQUE (gym_id, base_product_id)` is
 * what makes a repeated or concurrent import a no-op at the database
 * (NULLs, i.e. every Product the gym created itself, never collide). Deleting a
 * template sets it to NULL: the Product is the gym's own and stays.
 *
 * Backfill sets provenance on the rows that already came from a template and
 * touches nothing else: a System Product (`is_system = 1`) is matched to a live
 * template by its charge type code, or, for the template with no charge type,
 * by its name. A Product with no match keeps NULL; no Product is created,
 * changed or deleted.
 */

const TABLE = 'products';

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn(TABLE, 'base_product_id'))) {
    await knex.raw(`
      ALTER TABLE ${TABLE}
        ADD COLUMN base_product_id INT UNSIGNED NULL AFTER charge_type_id,
        ADD UNIQUE KEY products_gym_base_product_unique (gym_id, base_product_id),
        ADD CONSTRAINT products_base_product_id_foreign
          FOREIGN KEY (base_product_id) REFERENCES base_products (id) ON DELETE SET NULL
    `);
  }

  await knex.raw(`
    UPDATE ${TABLE} p
    JOIN charge_types ct ON ct.id = p.charge_type_id
    JOIN base_products b ON b.charge_type_code = ct.code AND b.deleted_at IS NULL
    SET p.base_product_id = b.id
    WHERE p.is_system = 1 AND p.base_product_id IS NULL
  `);
  await knex.raw(`
    UPDATE ${TABLE} p
    JOIN base_products b ON b.charge_type_code IS NULL AND b.deleted_at IS NULL AND b.name = p.name
    SET p.base_product_id = b.id
    WHERE p.is_system = 1 AND p.charge_type_id IS NULL AND p.base_product_id IS NULL
  `);
};

exports.down = async () => {};
