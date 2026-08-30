/**
 * #260: Base Training Catalog
 *
 * Makes gym_id nullable on the full training hierarchy so that Cordel-owned
 * (gym_id = NULL) base resources can coexist with gym-owned ones.
 * Adds cloned_from_id to exercises, workout_templates, training_plan_templates.
 */

/** Drop the gym_id→gyms FK, make gym_id NULL, re-add FK. Mirrors migration 105. */
async function makeGymIdNullable(knex, tableName, newFkName) {
  const [rows] = await knex.raw(`
    SELECT rc.CONSTRAINT_NAME
    FROM information_schema.REFERENTIAL_CONSTRAINTS rc
    JOIN information_schema.KEY_COLUMN_USAGE kcu
      ON kcu.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
     AND kcu.TABLE_SCHEMA   = rc.CONSTRAINT_SCHEMA
    WHERE rc.TABLE_NAME           = ?
      AND rc.REFERENCED_TABLE_NAME = 'gyms'
      AND rc.CONSTRAINT_SCHEMA    = DATABASE()
      AND kcu.COLUMN_NAME         = 'gym_id'
  `, [tableName]);

  for (const row of rows) {
    await knex.raw(`ALTER TABLE \`${tableName}\` DROP FOREIGN KEY \`${row.CONSTRAINT_NAME}\``).catch(() => {});
  }
  await knex.raw(`ALTER TABLE \`${tableName}\` MODIFY COLUMN gym_id CHAR(36) NULL`);
  await knex.raw(
    `ALTER TABLE \`${tableName}\` ADD CONSTRAINT \`${newFkName}\` FOREIGN KEY (gym_id) REFERENCES gyms(id) ON DELETE CASCADE`,
  ).catch(() => {});
}

exports.up = async (knex) => {
  // ── exercises: nullable gym_id + cloned_from_id ──────────────────────────
  if (await knex.schema.hasColumn('exercises', 'gym_id')) {
    await makeGymIdNullable(knex, 'exercises', 'exercises_gym_fk');
    await knex.raw('ALTER TABLE exercises DROP INDEX exercises_gym_name_unique').catch(() => {});
  }
  if (!(await knex.schema.hasColumn('exercises', 'cloned_from_id'))) {
    await knex.raw('ALTER TABLE exercises ADD COLUMN cloned_from_id INT UNSIGNED NULL');
    await knex.raw(
      'ALTER TABLE exercises ADD CONSTRAINT exercises_cloned_fk FOREIGN KEY (cloned_from_id) REFERENCES exercises(id) ON DELETE SET NULL',
    ).catch(() => {});
  }

  // ── exercise_muscles: nullable gym_id ────────────────────────────────────
  if (await knex.schema.hasColumn('exercise_muscles', 'gym_id')) {
    await makeGymIdNullable(knex, 'exercise_muscles', 'exercise_muscles_gym_fk');
  }

  // ── workout_templates: nullable gym_id + cloned_from_id ──────────────────
  if (await knex.schema.hasColumn('workout_templates', 'gym_id')) {
    await makeGymIdNullable(knex, 'workout_templates', 'workout_templates_gym_fk');
  }
  if (!(await knex.schema.hasColumn('workout_templates', 'cloned_from_id'))) {
    await knex.raw('ALTER TABLE workout_templates ADD COLUMN cloned_from_id INT UNSIGNED NULL');
    await knex.raw(
      'ALTER TABLE workout_templates ADD CONSTRAINT workout_templates_cloned_fk FOREIGN KEY (cloned_from_id) REFERENCES workout_templates(id) ON DELETE SET NULL',
    ).catch(() => {});
  }

  // ── workout_template_blocks: nullable gym_id ──────────────────────────────
  if (await knex.schema.hasColumn('workout_template_blocks', 'gym_id')) {
    await makeGymIdNullable(knex, 'workout_template_blocks', 'wtb_gym_fk');
  }

  // ── workout_template_exercises: nullable gym_id ───────────────────────────
  if (await knex.schema.hasColumn('workout_template_exercises', 'gym_id')) {
    await makeGymIdNullable(knex, 'workout_template_exercises', 'wte_gym_fk');
  }

  // ── training_plan_templates: nullable gym_id + cloned_from_id ────────────
  if (await knex.schema.hasColumn('training_plan_templates', 'gym_id')) {
    await makeGymIdNullable(knex, 'training_plan_templates', 'training_plan_templates_gym_fk');
    await knex.raw('ALTER TABLE training_plan_templates DROP INDEX tpt_gym_name_unique').catch(() => {});
  }
  if (!(await knex.schema.hasColumn('training_plan_templates', 'cloned_from_id'))) {
    await knex.raw('ALTER TABLE training_plan_templates ADD COLUMN cloned_from_id INT UNSIGNED NULL');
    await knex.raw(
      'ALTER TABLE training_plan_templates ADD CONSTRAINT tpt_cloned_from_fk FOREIGN KEY (cloned_from_id) REFERENCES training_plan_templates(id) ON DELETE SET NULL',
    ).catch(() => {});
  }

  // ── training_plan_template_workouts: nullable gym_id ─────────────────────
  if (await knex.schema.hasColumn('training_plan_template_workouts', 'gym_id')) {
    await makeGymIdNullable(knex, 'training_plan_template_workouts', 'tptw_gym_fk');
  }
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE training_plan_templates DROP FOREIGN KEY tpt_cloned_from_fk').catch(() => {});
  await knex.raw('ALTER TABLE training_plan_templates DROP COLUMN cloned_from_id').catch(() => {});
  await knex.raw('ALTER TABLE workout_templates DROP FOREIGN KEY workout_templates_cloned_fk').catch(() => {});
  await knex.raw('ALTER TABLE workout_templates DROP COLUMN cloned_from_id').catch(() => {});
  await knex.raw('ALTER TABLE exercises DROP FOREIGN KEY exercises_cloned_fk').catch(() => {});
  await knex.raw('ALTER TABLE exercises DROP COLUMN cloned_from_id').catch(() => {});

  for (const table of [
    'training_plan_template_workouts', 'training_plan_templates',
    'workout_template_exercises', 'workout_template_blocks', 'workout_templates',
    'exercise_muscles', 'exercises',
  ]) {
    await knex.raw(`ALTER TABLE \`${table}\` MODIFY COLUMN gym_id CHAR(36) NOT NULL`).catch(() => {});
  }
};
