/**
 * #55: reusable WorkoutTemplate -> WorkoutTemplateBlock -> WorkoutTemplateExercise
 * hierarchy. Blocks carry a Type (Standard/Superset/Triset/GiantSet/Circuit/
 * EMOM/AMRAP/Tabata) and a ResultType (None/Time/Rounds/Repetitions/Distance/
 * Calories/Weight/Score); the exact numeric fields needed to configure a
 * block aren't specified by the ticket, so a generic nullable set (rounds,
 * duration_seconds, work_seconds, rest_seconds) is used, interpreted per type.
 *
 * These entities have no Status field in the ticket, so lifecycle is plain
 * deleted_at (Members-style soft delete), not a status enum.
 */
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('workout_templates'))) {
    await knex.schema.createTable('workout_templates', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.string('name', 200).notNullable();
      t.text('description');
      t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
      t.datetime('deleted_at');
      t.index(['gym_id'], 'workout_templates_gym_index');
    });
  }

  if (!(await knex.schema.hasTable('workout_template_blocks'))) {
    await knex.schema.createTable('workout_template_blocks', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('workout_template_id').unsigned().notNullable()
        .references('id').inTable('workout_templates').onDelete('CASCADE');
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
      t.unique(['workout_template_id', 'position'], 'wtb_position_unique');
    });
    await knex.raw(
      "ALTER TABLE workout_template_blocks ADD CONSTRAINT wtb_type_check CHECK " +
      "(type IN ('Standard','Superset','Triset','GiantSet','Circuit','EMOM','AMRAP','Tabata'))",
    );
    await knex.raw(
      "ALTER TABLE workout_template_blocks ADD CONSTRAINT wtb_result_type_check CHECK " +
      "(result_type IN ('None','Time','Rounds','Repetitions','Distance','Calories','Weight','Score'))",
    );
  }

  if (!(await knex.schema.hasTable('workout_template_exercises'))) {
    await knex.schema.createTable('workout_template_exercises', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('workout_template_block_id').unsigned().notNullable()
        .references('id').inTable('workout_template_blocks').onDelete('CASCADE');
      t.integer('exercise_id').unsigned().notNullable()
        .references('id').inTable('exercises').onDelete('RESTRICT');
      t.integer('position').unsigned().notNullable();
      t.integer('min_reps').unsigned();
      t.integer('max_reps').unsigned();
      t.integer('sets').unsigned();
      t.integer('rest_seconds').unsigned();
      t.string('tempo', 40);
      t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
      t.datetime('modified_at');
      t.integer('modified_by_membership_id').unsigned()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
      t.datetime('deleted_at');
      t.unique(['workout_template_block_id', 'position'], 'wte_position_unique');
    });
  }
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('workout_template_exercises');
  await knex.raw('ALTER TABLE workout_template_blocks DROP CHECK wtb_type_check').catch(() => {});
  await knex.raw('ALTER TABLE workout_template_blocks DROP CHECK wtb_result_type_check').catch(() => {});
  await knex.schema.dropTableIfExists('workout_template_blocks');
  await knex.schema.dropTableIfExists('workout_templates');
};
