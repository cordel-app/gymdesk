/**
 * P5.2 (#31): workouts (ordered collections of exercises) + workout_exercises
 * (per-item overrides for reps and rest). weekday nullable so an ad-hoc
 * workout doesn't force a schedule.
 */
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('workouts'))) {
    await knex.schema.createTable('workouts', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.string('name', 200).notNullable();
      t.text('description');
      t.integer('weekday'); // 0–6
      t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
      t.index(['gym_id'], 'workouts_gym_index');
    });
    await knex.raw(
      "ALTER TABLE workouts ADD CONSTRAINT workouts_weekday_check " +
      "CHECK (weekday IS NULL OR weekday BETWEEN 0 AND 6)",
    );
  }

  if (!(await knex.schema.hasTable('workout_exercises'))) {
    await knex.schema.createTable('workout_exercises', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('workout_id').unsigned().notNullable()
        .references('id').inTable('workouts').onDelete('CASCADE');
      t.integer('exercise_id').unsigned().notNullable()
        .references('id').inTable('exercises').onDelete('RESTRICT');
      t.integer('position').unsigned().notNullable();
      t.string('reps', 40);
      t.integer('rest_seconds').unsigned();
      t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
      t.index(['workout_id', 'position'], 'workout_exercises_position_index');
    });
  }
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE workouts DROP CHECK workouts_weekday_check').catch(() => {});
  await knex.schema.dropTableIfExists('workout_exercises');
  await knex.schema.dropTableIfExists('workouts');
};
