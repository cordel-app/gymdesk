/**
 * P2.1 (#13): rooms per gym.
 * status is text + named CHECK so the enum can evolve without an ALTER TYPE.
 * (gym_id, name) unique to reject duplicate room names per tenant with 409.
 */
exports.up = async (knex) => {
  if (await knex.schema.hasTable('rooms')) return;
  await knex.schema.createTable('rooms', (t) => {
    t.increments('id').primary();
    t.specificType('gym_id', 'char(36)').notNullable()
      .references('id').inTable('gyms').onDelete('CASCADE');
    t.string('name', 120).notNullable();
    t.text('description');
    t.integer('capacity').unsigned().notNullable();
    t.string('status', 20).notNullable().defaultTo('active');
    t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
    t.unique(['gym_id', 'name'], 'rooms_gym_name_unique');
  });
  await knex.raw(
    "ALTER TABLE rooms ADD CONSTRAINT rooms_status_check " +
    "CHECK (status IN ('active','inactive'))",
  );
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE rooms DROP CHECK rooms_status_check').catch(() => {});
  await knex.schema.dropTableIfExists('rooms');
};
