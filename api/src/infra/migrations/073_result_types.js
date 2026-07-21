/**
 * #154: Result Type moves from Workout Block to Exercise instance level.
 * This migration creates:
 * - result_types: global catalog (9 types)
 * - exercise_allowed_result_types: which result types each exercise supports
 */
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('result_types'))) {
    await knex.schema.createTable('result_types', (t) => {
      t.increments('id').primary();
      t.string('name', 50).notNullable();
      t.string('slug', 30).notNullable().unique();
    });
    await knex('result_types').insert([
      { name: 'Repetitions', slug: 'repetitions' },
      { name: 'Weight',      slug: 'weight' },
      { name: 'Distance',    slug: 'distance' },
      { name: 'Duration',    slug: 'duration' },
      { name: 'Pace',        slug: 'pace' },
      { name: 'Speed',       slug: 'speed' },
      { name: 'Calories',    slug: 'calories' },
      { name: 'RPE',         slug: 'rpe' },
      { name: 'Rest Time',   slug: 'rest_time' },
    ]);
  }

  if (!(await knex.schema.hasTable('exercise_allowed_result_types'))) {
    await knex.schema.createTable('exercise_allowed_result_types', (t) => {
      t.integer('exercise_id').unsigned().notNullable()
        .references('id').inTable('exercises').onDelete('CASCADE');
      t.integer('result_type_id').unsigned().notNullable()
        .references('id').inTable('result_types').onDelete('CASCADE');
      t.primary(['exercise_id', 'result_type_id']);
    });
  }
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('exercise_allowed_result_types');
  await knex.schema.dropTableIfExists('result_types');
};
