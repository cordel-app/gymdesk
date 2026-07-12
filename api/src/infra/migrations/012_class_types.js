/**
 * P2.3 (#15): class_types per gym.
 * intensity_level 1–5, duration_minutes and max_capacity positive, speciality FK optional.
 */
exports.up = async (knex) => {
  if (await knex.schema.hasTable('class_types')) return;
  await knex.schema.createTable('class_types', (t) => {
    t.increments('id').primary();
    t.specificType('gym_id', 'char(36)').notNullable()
      .references('id').inTable('gyms').onDelete('CASCADE');
    t.string('name', 120).notNullable();
    t.text('description');
    t.integer('duration_minutes').unsigned().notNullable();
    t.integer('intensity_level').unsigned();
    t.integer('max_capacity').unsigned().notNullable();
    t.integer('speciality_id').unsigned()
      .references('id').inTable('specialities').onDelete('SET NULL');
    t.string('status', 20).notNullable().defaultTo('active');
    t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
    t.unique(['gym_id', 'name'], 'class_types_gym_name_unique');
  });
  await knex.raw(
    "ALTER TABLE class_types ADD CONSTRAINT class_types_status_check " +
    "CHECK (status IN ('active','inactive'))",
  );
  await knex.raw(
    "ALTER TABLE class_types ADD CONSTRAINT class_types_intensity_check " +
    "CHECK (intensity_level IS NULL OR intensity_level BETWEEN 1 AND 5)",
  );
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE class_types DROP CHECK class_types_status_check').catch(() => {});
  await knex.raw('ALTER TABLE class_types DROP CHECK class_types_intensity_check').catch(() => {});
  await knex.schema.dropTableIfExists('class_types');
};
