/**
 * #55: the Training domain is being replaced by a new Member-based workout
 * architecture (templates -> workouts -> blocks -> exercises, clone-on-assign,
 * 3-table logging). The legacy module (023-027) shipped ~2 days before this
 * migration with zero seed/production data (verified: no seed script
 * references these tables, admin "Training" dashboard was an unwired stub),
 * so this is a drop-and-recreate rather than a data-preserving migration.
 *
 * FK-safe child-to-parent drop order: workout_logs -> training_plans ->
 * training_plan_templates -> workout_exercises -> workouts. Each table's own
 * raw CHECK/generated-column/index artifacts are reversed first, mirroring
 * each file's own down().
 *
 * This migration is intentionally NOT reversible - down() throws rather than
 * pretending to restore dropped data.
 */
exports.up = async (knex) => {
  // Reverse 026's generated column + unique index before dropping training_plans.
  await knex.raw('ALTER TABLE training_plans DROP INDEX training_plans_one_active_per_weekday').catch(() => {});
  await knex.raw('ALTER TABLE training_plans DROP COLUMN active_weekday_key').catch(() => {});
  await knex.raw('ALTER TABLE training_plans DROP CHECK training_plans_weekday_check').catch(() => {});

  await knex.schema.dropTableIfExists('workout_logs');
  await knex.schema.dropTableIfExists('training_plans');

  await knex.raw('ALTER TABLE training_plan_templates DROP CHECK tpt_status_check').catch(() => {});
  await knex.raw('ALTER TABLE training_plan_templates DROP CHECK tpt_weekday_check').catch(() => {});
  await knex.schema.dropTableIfExists('training_plan_templates');

  await knex.schema.dropTableIfExists('workout_exercises');

  await knex.raw('ALTER TABLE workouts DROP CHECK workouts_weekday_check').catch(() => {});
  await knex.schema.dropTableIfExists('workouts');

  // muscles, exercises, exercise_muscles (023) are kept and extended in 036.
};

exports.down = async () => {
  throw new Error(
    '035_drop_legacy_training is a one-way migration; legacy training data is not recoverable this way. Restore from a DB backup instead.',
  );
};
