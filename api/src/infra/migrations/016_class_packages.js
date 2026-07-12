/**
 * P3.1 (#21): class_packages catalog.
 * All-positive integers; price mirrors membership_plans.base_price (10,2).
 */
exports.up = async (knex) => {
  if (await knex.schema.hasTable('class_packages')) return;
  await knex.schema.createTable('class_packages', (t) => {
    t.increments('id').primary();
    t.specificType('gym_id', 'char(36)').notNullable()
      .references('id').inTable('gyms').onDelete('CASCADE');
    t.string('name', 120).notNullable();
    t.integer('number_of_sessions').unsigned().notNullable();
    t.decimal('price', 10, 2).notNullable();
    t.integer('validity_days').unsigned().notNullable();
    t.string('status', 20).notNullable().defaultTo('active');
    t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
    t.unique(['gym_id', 'name'], 'class_packages_gym_name_unique');
  });
  await knex.raw(
    "ALTER TABLE class_packages ADD CONSTRAINT class_packages_status_check " +
    "CHECK (status IN ('active','inactive'))",
  );
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE class_packages DROP CHECK class_packages_status_check').catch(() => {});
  await knex.schema.dropTableIfExists('class_packages');
};
