/**
 * #55: ExerciseLog (one performed exercise) -> ExerciseLogSet (per-set
 * weight/reps/RPE). Member-authored, so ModifiedBy/CreatedBy reference
 * members.id, not gym_memberships.id (distinct from the staff-authored
 * *_membership_id columns elsewhere in this domain).
 *
 * Members may edit their own logs (ownership-checked at the route layer) —
 * the ticket's field lists include ModifiedAt/ModifiedBy on ExerciseLog and
 * dropped the earlier "logs must never change" language, so this is not
 * purely insert-only. No DELETE route is exposed regardless.
 */
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('exercise_logs'))) {
    await knex.schema.createTable('exercise_logs', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('member_id').unsigned().notNullable()
        .references('id').inTable('members').onDelete('CASCADE');
      t.integer('workout_exercise_id').unsigned().notNullable()
        .references('id').inTable('workout_exercises').onDelete('RESTRICT');
      t.integer('exercise_id').unsigned().notNullable()
        .references('id').inTable('exercises').onDelete('RESTRICT');
      t.date('logged_date').notNullable();
      t.text('notes');
      t.integer('duration_seconds').unsigned();
      t.boolean('skipped').notNullable().defaultTo(false);
      t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
      t.datetime('modified_at');
      t.integer('modified_by_member_id').unsigned()
        .references('id').inTable('members').onDelete('SET NULL');
      t.index(['gym_id', 'member_id', 'logged_date'], 'exercise_logs_member_date_index');
    });
  }

  if (!(await knex.schema.hasTable('exercise_log_sets'))) {
    await knex.schema.createTable('exercise_log_sets', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('exercise_log_id').unsigned().notNullable()
        .references('id').inTable('exercise_logs').onDelete('CASCADE');
      t.integer('set_number').unsigned().notNullable();
      t.decimal('weight', 6, 2);
      t.integer('reps').unsigned();
      t.decimal('rpe', 3, 1);
      t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
      t.unique(['exercise_log_id', 'set_number'], 'exercise_log_sets_number_unique');
    });
    await knex.raw(
      'ALTER TABLE exercise_log_sets ADD CONSTRAINT els_rpe_check ' +
      'CHECK (rpe IS NULL OR rpe BETWEEN 1.0 AND 10.0)',
    );
  }
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE exercise_log_sets DROP CHECK els_rpe_check').catch(() => {});
  await knex.schema.dropTableIfExists('exercise_log_sets');
  await knex.schema.dropTableIfExists('exercise_logs');
};
