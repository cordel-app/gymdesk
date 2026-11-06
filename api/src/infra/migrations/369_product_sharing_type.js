/**
 * #2393: `sharing_type` on `base_products` and `products` — whether a Product is
 * for one member (`individual`) or can be shared between several (`shared`).
 *
 * NOT NULL DEFAULT 'individual' is the migration treatment for every existing
 * row (the behaviour today is individual use). No CHECK, matching
 * `one_time_purchase` / `mandatory` (ADD CONSTRAINT rebuilds the table under
 * ALGORITHM=COPY); the accepted set lives in `domain/baseProducts.ts`.
 */
exports.up = async (knex) => {
  for (const table of ['base_products', 'products']) {
    if (!(await knex.schema.hasColumn(table, 'sharing_type'))) {
      await knex.schema.alterTable(table, (t) => {
        t.string('sharing_type', 20).notNullable().defaultTo('individual');
      });
    }
  }
};

exports.down = async (knex) => {
  for (const table of ['base_products', 'products']) {
    if (await knex.schema.hasColumn(table, 'sharing_type')) {
      await knex.schema.alterTable(table, (t) => { t.dropColumn('sharing_type'); });
    }
  }
};
