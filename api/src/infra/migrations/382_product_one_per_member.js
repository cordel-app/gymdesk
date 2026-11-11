/**
 * #2607: `one_per_member` on `base_products` and `products` — a Product a member
 * may hold at most one assignment of. NOT NULL DEFAULT 0, so no existing Product
 * becomes restricted. No CHECK, matching `one_time_purchase` / `mandatory`
 * (ADD CONSTRAINT rebuilds the table under ALGORITHM=COPY).
 */
exports.up = async (knex) => {
  for (const table of ['base_products', 'products']) {
    if (!(await knex.schema.hasColumn(table, 'one_per_member'))) {
      await knex.schema.alterTable(table, (t) => {
        t.boolean('one_per_member').notNullable().defaultTo(false);
      });
    }
  }
};

exports.down = async (knex) => {
  for (const table of ['base_products', 'products']) {
    if (await knex.schema.hasColumn(table, 'one_per_member')) {
      await knex.schema.alterTable(table, (t) => { t.dropColumn('one_per_member'); });
    }
  }
};
