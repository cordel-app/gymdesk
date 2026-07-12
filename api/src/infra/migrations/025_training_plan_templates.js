/**
 * P5.3 (#32): training_plan_templates — reusable blueprint referencing a
 * workout, with per-plan reps/rest/weekday overrides. active/inactive.
 */
exports.up = async (knex) => {
  if (await knex.schema.hasTable('training_plan_templates')) return;
  await knex.schema.createTable('training_plan_templates', (t) => {
    t.increments('id').primary();
    t.specificType('gym_id', 'char(36)').notNullable()
      .references('id').inTable('gyms').onDelete('CASCADE');
    t.string('name', 200).notNullable();
    t.text('description');
    t.integer('workout_id').unsigned().notNullable()
      .references('id').inTable('workouts').onDelete('RESTRICT');
    t.string('reps', 40);
    t.integer('rest_seconds').unsigned();
    t.integer('weekday'); // 0–6 or NULL
    t.string('status', 20).notNullable().defaultTo('active');
    t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
    t.index(['gym_id'], 'training_plan_templates_gym_index');
  });
  await knex.raw(
    "ALTER TABLE training_plan_templates ADD CONSTRAINT tpt_status_check " +
    "CHECK (status IN ('active','inactive'))",
  );
  await knex.raw(
    "ALTER TABLE training_plan_templates ADD CONSTRAINT tpt_weekday_check " +
    "CHECK (weekday IS NULL OR weekday BETWEEN 0 AND 6)",
  );
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE training_plan_templates DROP CHECK tpt_status_check').catch(() => {});
  await knex.raw('ALTER TABLE training_plan_templates DROP CHECK tpt_weekday_check').catch(() => {});
  await knex.schema.dropTableIfExists('training_plan_templates');
};
