/**
 * #55: TrainingPlanTemplate (reusable program) + TrainingPlanTemplateWorkout
 * (ordered junction to WorkoutTemplate — a template is a multi-day program,
 * not a single workout). Status: active/inactive/draft/deleted (soft-delete
 * via a 'deleted' status value + deleted_at, per ticket clarification).
 */
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('training_plan_templates'))) {
    await knex.schema.createTable('training_plan_templates', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.string('name', 200).notNullable();
      t.text('description');
      t.string('status', 20).notNullable().defaultTo('active');
      t.integer('created_by_membership_id').unsigned()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
      t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
      t.datetime('modified_at');
      t.datetime('deleted_at');
      t.unique(['gym_id', 'name'], 'tpt_gym_name_unique');
    });
    await knex.raw(
      "ALTER TABLE training_plan_templates ADD CONSTRAINT tpt_status_check " +
      "CHECK (status IN ('active','inactive','draft','deleted'))",
    );
  }

  if (!(await knex.schema.hasTable('training_plan_template_workouts'))) {
    await knex.schema.createTable('training_plan_template_workouts', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('training_plan_template_id').unsigned().notNullable();
      t.foreign('training_plan_template_id', 'tptw_template_id_fk')
        .references('id').inTable('training_plan_templates').onDelete('CASCADE');
      t.integer('workout_template_id').unsigned().notNullable()
        .references('id').inTable('workout_templates').onDelete('RESTRICT');
      t.integer('position').unsigned().notNullable();
      t.integer('scheduled_weekday'); // 0-6 or NULL — default-date hint only
      t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
      t.unique(['training_plan_template_id', 'position'], 'tptw_position_unique');
    });
    await knex.raw(
      "ALTER TABLE training_plan_template_workouts ADD CONSTRAINT tptw_weekday_check " +
      "CHECK (scheduled_weekday IS NULL OR scheduled_weekday BETWEEN 0 AND 6)",
    );
  }
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE training_plan_template_workouts DROP CHECK tptw_weekday_check').catch(() => {});
  await knex.schema.dropTableIfExists('training_plan_template_workouts');
  await knex.raw('ALTER TABLE training_plan_templates DROP CHECK tpt_status_check').catch(() => {});
  await knex.schema.dropTableIfExists('training_plan_templates');
};
