/**
 * #130: Exercise type adaptation for inline workout template editor.
 * - exercises.exercise_type: drives which columns the UI renders per exercise row.
 * - workout_template_exercises: duration_seconds (time-based), distance_value +
 *   distance_unit (distance-based) — reps-based exercises leave these NULL.
 */
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('exercises', 'exercise_type'))) {
    await knex.schema.alterTable('exercises', (t) => {
      t.string('exercise_type', 20).notNullable().defaultTo('reps').after('name');
    });
    await knex.raw(
      "ALTER TABLE exercises ADD CONSTRAINT exercises_exercise_type_check " +
      "CHECK (exercise_type IN ('reps','time','distance'))",
    );
  }

  if (!(await knex.schema.hasColumn('workout_template_exercises', 'duration_seconds'))) {
    await knex.schema.alterTable('workout_template_exercises', (t) => {
      t.integer('duration_seconds').unsigned().after('tempo');
      t.decimal('distance_value', 8, 2).unsigned().after('duration_seconds');
      t.string('distance_unit', 20).after('distance_value');
    });
  }
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE exercises DROP CHECK exercises_exercise_type_check').catch(() => {});
  if (await knex.schema.hasColumn('exercises', 'exercise_type')) {
    await knex.schema.alterTable('exercises', (t) => { t.dropColumn('exercise_type'); });
  }
  if (await knex.schema.hasColumn('workout_template_exercises', 'duration_seconds')) {
    await knex.schema.alterTable('workout_template_exercises', (t) => {
      t.dropColumn('duration_seconds');
      t.dropColumn('distance_value');
      t.dropColumn('distance_unit');
    });
  }
};
