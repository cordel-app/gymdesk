/**
 * #55: the clone-side hierarchy — TrainingPlan -> Workout -> WorkoutBlock ->
 * WorkoutExercise. A TrainingPlan is either cloned from a TrainingPlanTemplate
 * at assignment time, or created ad-hoc from scratch (template_id nullable),
 * per the ticket's confirmed assignment workflow. Once assigned, a trainer
 * can freely restructure it — editing a clone never touches the original
 * template (template_id is traceability-only, never re-synced).
 *
 * Unlike the template side, there's no many-to-many junction here: a cloned
 * Workout belongs to exactly one TrainingPlan (never shared across members),
 * so a direct training_plan_id FK + position is sufficient.
 *
 * These entities have no Status field in the ticket except TrainingPlan
 * itself, so Workout/WorkoutBlock/WorkoutExercise get plain deleted_at
 * soft-delete; TrainingPlan gets a status column + 'deleted' value.
 */
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('training_plans'))) {
    await knex.schema.createTable('training_plans', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('member_id').unsigned().notNullable()
        .references('id').inTable('members').onDelete('CASCADE');
      t.integer('template_id').unsigned()
        .references('id').inTable('training_plan_templates').onDelete('SET NULL');
      t.string('name', 200).notNullable();
      t.text('description');
      t.string('status', 20).notNullable().defaultTo('active');
      t.integer('assigned_by_membership_id').unsigned()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
      t.integer('modified_by_membership_id').unsigned()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
      t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
      t.datetime('modified_at');
      t.datetime('deleted_at');
      t.index(['gym_id', 'member_id'], 'training_plans_gym_member_index');
    });
    await knex.raw(
      "ALTER TABLE training_plans ADD CONSTRAINT training_plans_status_check " +
      "CHECK (status IN ('active','inactive','deleted'))",
    );
  }

  if (!(await knex.schema.hasTable('workouts'))) {
    await knex.schema.createTable('workouts', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('training_plan_id').unsigned().notNullable()
        .references('id').inTable('training_plans').onDelete('CASCADE');
      t.string('name', 200).notNullable();
      t.text('description');
      t.integer('position').unsigned().notNullable();
      t.integer('scheduled_weekday'); // nullable, default-date hint only, no uniqueness rule
      t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
      t.datetime('deleted_at');
      t.unique(['training_plan_id', 'position'], 'workouts_position_unique');
    });
    await knex.raw(
      "ALTER TABLE workouts ADD CONSTRAINT workouts_weekday_check " +
      "CHECK (scheduled_weekday IS NULL OR scheduled_weekday BETWEEN 0 AND 6)",
    );
  }

  if (!(await knex.schema.hasTable('workout_blocks'))) {
    await knex.schema.createTable('workout_blocks', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('workout_id').unsigned().notNullable()
        .references('id').inTable('workouts').onDelete('CASCADE');
      t.integer('position').unsigned().notNullable();
      t.string('name', 200);
      t.text('description');
      t.string('type', 20).notNullable();
      t.string('result_type', 20).notNullable().defaultTo('None');
      t.integer('rounds').unsigned();
      t.integer('duration_seconds').unsigned();
      t.integer('work_seconds').unsigned();
      t.integer('rest_seconds').unsigned();
      t.boolean('is_optional').notNullable().defaultTo(false);
      t.text('notes');
      t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
      t.datetime('modified_at');
      t.integer('modified_by_membership_id').unsigned()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
      t.datetime('deleted_at');
      t.unique(['workout_id', 'position'], 'workout_blocks_position_unique');
    });
    await knex.raw(
      "ALTER TABLE workout_blocks ADD CONSTRAINT wb_type_check CHECK " +
      "(type IN ('Standard','Superset','Triset','GiantSet','Circuit','EMOM','AMRAP','Tabata'))",
    );
    await knex.raw(
      "ALTER TABLE workout_blocks ADD CONSTRAINT wb_result_type_check CHECK " +
      "(result_type IN ('None','Time','Rounds','Repetitions','Distance','Calories','Weight','Score'))",
    );
  }

  if (!(await knex.schema.hasTable('workout_exercises'))) {
    await knex.schema.createTable('workout_exercises', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('workout_block_id').unsigned().notNullable()
        .references('id').inTable('workout_blocks').onDelete('CASCADE');
      t.integer('exercise_id').unsigned().notNullable()
        .references('id').inTable('exercises').onDelete('RESTRICT');
      t.integer('position').unsigned().notNullable();
      t.integer('min_reps').unsigned();
      t.integer('max_reps').unsigned();
      t.integer('sets').unsigned();
      t.integer('rest_seconds').unsigned();
      t.string('tempo', 40);
      t.text('notes');
      t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
      t.datetime('modified_at');
      t.integer('modified_by_membership_id').unsigned()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
      t.datetime('deleted_at');
      t.unique(['workout_block_id', 'position'], 'workout_exercises_position_unique');
    });
  }
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('workout_exercises');
  await knex.raw('ALTER TABLE workout_blocks DROP CHECK wb_type_check').catch(() => {});
  await knex.raw('ALTER TABLE workout_blocks DROP CHECK wb_result_type_check').catch(() => {});
  await knex.schema.dropTableIfExists('workout_blocks');
  await knex.raw('ALTER TABLE workouts DROP CHECK workouts_weekday_check').catch(() => {});
  await knex.schema.dropTableIfExists('workouts');
  await knex.raw('ALTER TABLE training_plans DROP CHECK training_plans_status_check').catch(() => {});
  await knex.schema.dropTableIfExists('training_plans');
};
