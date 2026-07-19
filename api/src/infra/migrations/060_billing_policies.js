/**
 * #70: Create billing_policies table — one row per membership plan.
 */
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('billing_policies'))) {
    await knex.schema.createTable('billing_policies', (t) => {
      t.increments('id').unsigned().primary();
      t.specificType('gym_id', 'char(36)').notNullable().references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('membership_plan_id').unsigned().notNullable().references('id').inTable('membership_plans').onDelete('CASCADE');
      t.integer('initial_billing_interval').unsigned().notNullable().defaultTo(1);
      t.enum('initial_billing_unit', ['day', 'week', 'month', 'year']).notNullable().defaultTo('month');
      t.integer('recurring_billing_interval').unsigned().notNullable().defaultTo(1);
      t.enum('recurring_billing_unit', ['day', 'week', 'month', 'year']).notNullable().defaultTo('month');
      t.integer('initial_service_interval').unsigned().notNullable().defaultTo(1);
      t.enum('initial_service_unit', ['day', 'week', 'month', 'year']).notNullable().defaultTo('month');
      t.integer('recurring_service_interval').unsigned().notNullable().defaultTo(1);
      t.enum('recurring_service_unit', ['day', 'week', 'month', 'year']).notNullable().defaultTo('month');
      t.boolean('auto_renew').notNullable().defaultTo(true);
      t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
      t.unique(['membership_plan_id']);
    });
  }
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('billing_policies');
};
