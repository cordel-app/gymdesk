/**
 * #55: WorkoutBlockLog — completion of a workout block. result_type is a
 * denormalized snapshot of the block's ResultType at logging time (so a
 * later template/block edit never reinterprets historical results);
 * result_value stores the value as text since its meaning depends on
 * result_type (seconds, distance, weight, score, rounds, ...).
 */
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('workout_block_logs'))) {
    await knex.schema.createTable('workout_block_logs', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('member_id').unsigned().notNullable()
        .references('id').inTable('members').onDelete('CASCADE');
      t.integer('workout_block_id').unsigned().notNullable()
        .references('id').inTable('workout_blocks').onDelete('RESTRICT');
      t.date('logged_date').notNullable();
      t.datetime('started_at');
      t.datetime('finished_at');
      t.string('result_type', 20).notNullable();
      t.string('result_value', 60);
      t.text('notes');
      t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
      t.datetime('modified_at');
      t.integer('modified_by_member_id').unsigned()
        .references('id').inTable('members').onDelete('SET NULL');
      t.index(['gym_id', 'member_id', 'logged_date'], 'wbl_member_date_index');
    });
    await knex.raw(
      "ALTER TABLE workout_block_logs ADD CONSTRAINT wbl_result_type_check CHECK " +
      "(result_type IN ('None','Time','Rounds','Repetitions','Distance','Calories','Weight','Score'))",
    );
  }
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE workout_block_logs DROP CHECK wbl_result_type_check').catch(() => {});
  await knex.schema.dropTableIfExists('workout_block_logs');
};
