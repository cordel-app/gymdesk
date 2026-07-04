exports.up = async (knex) => {
  await knex.schema.createTable('fares', (t) => {
    t.increments('id').primary();
    t.specificType('gym_id', 'char(36)').notNullable()
      .references('id').inTable('gyms').onDelete('CASCADE');
    t.string('name', 255).notNullable();
    t.decimal('price', 10, 2).notNullable();
    t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
  });

  await knex.schema.alterTable('members', (t) => {
    t.integer('fare_id').unsigned()
      .references('id').inTable('fares').onDelete('SET NULL');
  });
};

exports.down = async (knex) => {
  await knex.schema.alterTable('members', (t) => {
    t.dropForeign('fare_id');
    t.dropColumn('fare_id');
  });
  await knex.schema.dropTableIfExists('fares');
};
