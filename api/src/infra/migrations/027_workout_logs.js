/**
 * P5.5 (#34): workout_logs — one row per set (series). Weight optional
 * (bodyweight exercises), reps required. logged_date is a plain DATE so a
 * member's "today" doesn't drift with timezone edge cases.
 */
exports.up = async (knex) => {
  if (await knex.schema.hasTable('workout_logs')) return;
  await knex.schema.createTable('workout_logs', (t) => {
    t.increments('id').primary();
    t.specificType('gym_id', 'char(36)').notNullable()
      .references('id').inTable('gyms').onDelete('CASCADE');
    t.integer('member_id').unsigned().notNullable()
      .references('id').inTable('members').onDelete('CASCADE');
    t.integer('training_plan_id').unsigned().notNullable()
      .references('id').inTable('training_plans').onDelete('CASCADE');
    t.integer('workout_exercise_id').unsigned().notNullable()
      .references('id').inTable('workout_exercises').onDelete('CASCADE');
    t.date('logged_date').notNullable();
    t.integer('series').notNullable();
    t.decimal('weight', 6, 2);
    t.integer('reps').notNullable();
    t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
    t.index(['gym_id', 'member_id', 'logged_date'], 'workout_logs_member_date_index');
    t.index(['workout_exercise_id'], 'workout_logs_exercise_index');
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('workout_logs');
};
