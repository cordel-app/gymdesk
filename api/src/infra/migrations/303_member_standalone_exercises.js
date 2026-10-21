/**
 * #1916 — standalone exercises: an exercise a member adds to one day of My
 * Training without touching their assigned Training Plan.
 *
 * `member_standalone_exercises` is that addition (member + exercise + date);
 * `UNIQUE (member_id, exercise_id, exercise_date)` is what stops the same
 * exercise being added twice to a day. What the member performed is the
 * existing `exercise_logs` / `exercise_log_sets` model: a log of a standalone
 * exercise has `standalone_exercise_id` set and no `workout_exercise_id`, so
 * `workout_exercise_id` becomes nullable (a NOT NULL -> NULL change is in place).
 * Logs stay keyed to the exercise, so My Progress counts them with no change.
 * The route (not a CHECK, which would rebuild the table) requires exactly one
 * of the two ids.
 */
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('member_standalone_exercises'))) {
    await knex.schema.createTable('member_standalone_exercises', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('member_id').unsigned().notNullable()
        .references('id').inTable('members').onDelete('CASCADE');
      t.integer('exercise_id').unsigned().notNullable()
        .references('id').inTable('exercises').onDelete('RESTRICT');
      t.date('exercise_date').notNullable();
      t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
      t.unique(['member_id', 'exercise_id', 'exercise_date'], 'member_standalone_exercises_unique');
      t.index(['gym_id', 'member_id', 'exercise_date'], 'member_standalone_exercises_day_index');
    });
  }

  if (!(await knex.schema.hasColumn('exercise_logs', 'standalone_exercise_id'))) {
    await knex.raw(`
      ALTER TABLE exercise_logs
        MODIFY COLUMN workout_exercise_id INT UNSIGNED NULL,
        ADD COLUMN standalone_exercise_id INT UNSIGNED NULL,
        ADD CONSTRAINT exercise_logs_standalone_exercise_id_foreign
          FOREIGN KEY (standalone_exercise_id) REFERENCES member_standalone_exercises (id) ON DELETE RESTRICT
    `);
  }
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('exercise_logs', 'standalone_exercise_id')) {
    await knex.raw('DELETE FROM exercise_log_sets WHERE exercise_log_id IN (SELECT id FROM exercise_logs WHERE workout_exercise_id IS NULL)');
    await knex.raw('DELETE FROM exercise_logs WHERE workout_exercise_id IS NULL');
    await knex.raw(`
      ALTER TABLE exercise_logs
        DROP FOREIGN KEY exercise_logs_standalone_exercise_id_foreign,
        DROP COLUMN standalone_exercise_id,
        MODIFY COLUMN workout_exercise_id INT UNSIGNED NOT NULL
    `);
  }
  await knex.schema.dropTableIfExists('member_standalone_exercises');
};
