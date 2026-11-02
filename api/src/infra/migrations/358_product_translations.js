/**
 * #2254 — Product Name and Description in every supported language.
 *
 * `products` / `base_products` keep `name` / `description` as the base-locale
 * (English) value and the fallback; every other locale is one row of
 * `product_translations` (a gym's own Product, imported or not) or
 * `base_product_translations` (a Cordel template). Same shape as
 * `professional_service_translations` (#2110). No backfill: no translation is
 * invented, a locale with no row falls back to the base text at read time.
 */
exports.up = async (knex) => {
  for (const [table, fkCol, parent] of [
    ['product_translations', 'product_id', 'products'],
    ['base_product_translations', 'base_product_id', 'base_products'],
  ]) {
    if (await knex.schema.hasTable(table)) continue;
    await knex.raw(`
      CREATE TABLE ${table} (
        ${fkCol}     INT UNSIGNED NOT NULL,
        locale       VARCHAR(10)  NOT NULL,
        name         VARCHAR(150) NOT NULL,
        description  TEXT NULL,
        created_at   DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
        modified_at  DATETIME NULL,
        PRIMARY KEY (${fkCol}, locale),
        CONSTRAINT ${table}_parent_fk FOREIGN KEY (${fkCol})
          REFERENCES ${parent}(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }
};

exports.down = async () => {};
