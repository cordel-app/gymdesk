/**
 * P5.1 (#30): per-gym exercise catalog. Gyms customize videos/descriptions,
 * so gym_id on every row (no shared master catalog). exercise_muscles
 * carries a role (principal/secondary) via named CHECK.
 */
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('muscles'))) {
    await knex.schema.createTable('muscles', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.string('name', 120).notNullable();
      t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
      t.unique(['gym_id', 'name'], 'muscles_gym_name_unique');
    });
  }

  if (!(await knex.schema.hasTable('exercises'))) {
    await knex.schema.createTable('exercises', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.string('name', 200).notNullable();
      t.text('description');
      t.string('video_url', 500);
      t.string('image_url', 500);
      t.string('default_reps', 40); // e.g. "3x10" — free text
      t.integer('default_rest_seconds').unsigned();
      t.string('status', 20).notNullable().defaultTo('active');
      t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
      t.unique(['gym_id', 'name'], 'exercises_gym_name_unique');
    });
    await knex.raw(
      "ALTER TABLE exercises ADD CONSTRAINT exercises_status_check " +
      "CHECK (status IN ('active','inactive'))",
    );
  }

  if (!(await knex.schema.hasTable('exercise_muscles'))) {
    await knex.schema.createTable('exercise_muscles', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('exercise_id').unsigned().notNullable()
        .references('id').inTable('exercises').onDelete('CASCADE');
      t.integer('muscle_id').unsigned().notNullable()
        .references('id').inTable('muscles').onDelete('CASCADE');
      t.string('role', 20).notNullable();
      t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
      t.unique(['exercise_id', 'muscle_id'], 'exercise_muscles_unique_pair');
    });
    await knex.raw(
      "ALTER TABLE exercise_muscles ADD CONSTRAINT exercise_muscles_role_check " +
      "CHECK (role IN ('principal','secondary'))",
    );
  }
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE exercise_muscles DROP CHECK exercise_muscles_role_check').catch(() => {});
  await knex.raw('ALTER TABLE exercises DROP CHECK exercises_status_check').catch(() => {});
  await knex.schema.dropTableIfExists('exercise_muscles');
  await knex.schema.dropTableIfExists('exercises');
  await knex.schema.dropTableIfExists('muscles');
};
