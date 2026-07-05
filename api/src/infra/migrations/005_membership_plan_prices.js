/**
 * P1.3 (#7): time-boxed prices per membership plan.
 * A plan's base_price is the headline number; membership_plan_prices records
 * what it actually costs during a given validity window (valid_to NULL = open-ended).
 * The (membership_plan_id, valid_from) index makes the "effective price today"
 * lookup a single indexed range scan.
 */

exports.up = async (knex) => {
  await knex.schema.createTable('membership_plan_prices', (t) => {
    t.increments('id').primary();
    t.specificType('gym_id', 'char(36)').notNullable()
      .references('id').inTable('gyms').onDelete('CASCADE');
    t.integer('membership_plan_id').unsigned().notNullable()
      .references('id').inTable('membership_plans').onDelete('CASCADE');
    t.decimal('price', 10, 2).notNullable();
    t.date('valid_from').notNullable();
    t.date('valid_to');
    t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
    t.index(['membership_plan_id', 'valid_from'], 'mpp_plan_valid_from_index');
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('membership_plan_prices');
};
