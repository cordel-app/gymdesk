/**
 * #55: Exercise gains structured default training values, replacing the old
 * free-text default_reps/default_rest_seconds (dead columns once the legacy
 * workouts/training-plans routers are deleted - nothing else reads them).
 */
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('exercises', 'min_reps_default'))) {
    await knex.schema.alterTable('exercises', (t) => {
      t.dropColumn('default_reps');
      t.dropColumn('default_rest_seconds');
      t.integer('min_reps_default').unsigned();
      t.integer('max_reps_default').unsigned();
      t.integer('rest_default_seconds').unsigned();
      t.integer('sets_default').unsigned();
      t.text('notes_default');
    });
    await knex.raw(
      'ALTER TABLE exercises ADD CONSTRAINT exercises_reps_range_check ' +
      'CHECK (min_reps_default IS NULL OR max_reps_default IS NULL OR min_reps_default <= max_reps_default)',
    );
  }
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE exercises DROP CHECK exercises_reps_range_check').catch(() => {});
  await knex.schema.alterTable('exercises', (t) => {
    t.dropColumn('min_reps_default');
    t.dropColumn('max_reps_default');
    t.dropColumn('rest_default_seconds');
    t.dropColumn('sets_default');
    t.dropColumn('notes_default');
    t.string('default_reps', 40);
    t.integer('default_rest_seconds').unsigned();
  });
};
