/**
 * P5.4 (#33): per-member training_plans.
 * template_id nullable (ad-hoc plans supported). Copy semantics — the plan
 * carries its own name/reps/rest/weekday, so template edits don't drift into
 * assigned plans. deactivated_at is nullable; a plan is 'active' iff
 * deactivated_at IS NULL.
 *
 * "One active plan per member per weekday": enforced via the P1.5 generated
 * column + unique index pattern. active_weekday_key = IF(deactivated_at
 * IS NULL, weekday, NULL); UNIQUE(member_id, active_weekday_key).
 */
exports.up = async (knex) => {
  if (await knex.schema.hasTable('training_plans')) return;
  await knex.schema.createTable('training_plans', (t) => {
    t.increments('id').primary();
    t.specificType('gym_id', 'char(36)').notNullable()
      .references('id').inTable('gyms').onDelete('CASCADE');
    t.integer('member_id').unsigned().notNullable()
      .references('id').inTable('members').onDelete('CASCADE');
    t.integer('workout_id').unsigned().notNullable()
      .references('id').inTable('workouts').onDelete('RESTRICT');
    t.integer('template_id').unsigned()
      .references('id').inTable('training_plan_templates').onDelete('SET NULL');
    t.string('name', 200).notNullable();
    t.text('description');
    t.string('reps', 40);
    t.integer('rest_seconds').unsigned();
    t.integer('weekday'); // 0–6 or NULL (unscheduled)
    t.datetime('activated_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
    t.datetime('deactivated_at');
    t.string('assigned_by', 64);
    t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
    t.index(['gym_id', 'member_id'], 'training_plans_gym_member_index');
  });
  await knex.raw(
    "ALTER TABLE training_plans ADD CONSTRAINT training_plans_weekday_check " +
    "CHECK (weekday IS NULL OR weekday BETWEEN 0 AND 6)",
  );
  await knex.raw(
    "ALTER TABLE training_plans " +
    "ADD COLUMN active_weekday_key INT UNSIGNED " +
    "GENERATED ALWAYS AS (IF(deactivated_at IS NULL AND weekday IS NOT NULL, weekday, NULL)) VIRTUAL",
  );
  await knex.raw(
    "ALTER TABLE training_plans ADD UNIQUE KEY training_plans_one_active_per_weekday (member_id, active_weekday_key)",
  );
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE training_plans DROP INDEX training_plans_one_active_per_weekday').catch(() => {});
  await knex.raw('ALTER TABLE training_plans DROP COLUMN active_weekday_key').catch(() => {});
  await knex.raw('ALTER TABLE training_plans DROP CHECK training_plans_weekday_check').catch(() => {});
  await knex.schema.dropTableIfExists('training_plans');
};
