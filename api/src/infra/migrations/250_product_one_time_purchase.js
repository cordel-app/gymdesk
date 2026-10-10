/**
 * #1349: `products.one_time_purchase`, an explicit flag marking a Product
 * meant to be purchased once by a member. Independent of `billing_frequency`
 * (a `once` Product is not automatically one-time) and, in this ticket, not
 * enforced anywhere: it identifies, it does not restrict.
 *
 * NOT NULL DEFAULT 0 leaves every existing Product unflagged; the backfill
 * then flags the two System Products the ticket names in every gym, keyed on
 * the charge type and `is_system = 1` so a Custom Product a gym happened to
 * name the same is untouched. It only ever sets the flag on those rows, so it
 * is idempotent and overwrites no other configuration. No CHECK, matching
 * `products.mandatory` (ADD CONSTRAINT would rebuild the table).
 */
const ONE_TIME_CODES = ['premium_fitness_app', 'registration_fee'];

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('products', 'one_time_purchase'))) {
    await knex.schema.alterTable('products', (t) => {
      t.boolean('one_time_purchase').notNullable().defaultTo(0);
    });
  }
  await knex.raw(
    `UPDATE products p
       JOIN charge_types ct ON ct.id = p.charge_type_id
        SET p.one_time_purchase = 1
      WHERE p.is_system = 1 AND ct.code IN (?, ?)`,
    ONE_TIME_CODES,
  );
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('products', 'one_time_purchase')) {
    await knex.schema.alterTable('products', (t) => {
      t.dropColumn('one_time_purchase');
    });
  }
};
