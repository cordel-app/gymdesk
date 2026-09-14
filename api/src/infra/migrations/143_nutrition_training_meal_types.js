/**
 * #502: Nutrition Plan Templates — Training-Related Meal Types
 *
 * Widens meal_type CHECK constraints on both nutrition_plan_template_meals
 * and member_nutrition_plan_meals to accept 3 new training-related values:
 * 'two_three_hours_before_training', 'immediately_before_training',
 * 'immediately_after_training'.
 *
 * Follows the same guarded drop-and-recreate pattern as migration 123 (which
 * added 'four_weeks' to gym_charges.billing_frequency the same way): MySQL's
 * DROP CHECK has no IF EXISTS, so we check information_schema first, and
 * DROP+ADD are combined into a single ALTER TABLE statement so the
 * constraint is never briefly absent mid-migration.
 */

const constraintExists = (knex, table, name) =>
  knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?`,
    [table, name],
  ).then(([rows]) => rows[0].cnt > 0);

async function setMealTypeCheck(knex, table, constraintName, values) {
  const check = `CHECK (meal_type IS NULL OR meal_type IN (${values.map((v) => `'${v}'`).join(',')}))`;
  const hasConstraint = await constraintExists(knex, table, constraintName);
  if (hasConstraint) {
    await knex.raw(`
      ALTER TABLE ${table}
        DROP CHECK ${constraintName},
        ADD CONSTRAINT ${constraintName} ${check}
    `);
  } else {
    await knex.raw(`ALTER TABLE ${table} ADD CONSTRAINT ${constraintName} ${check}`);
  }
}

const MEAL_TYPES_WITH_TRAINING = [
  'recien_levantado', 'breakfast', 'media_manana', 'lunch', 'snack', 'dinner', 'antes_de_dormir',
  'two_three_hours_before_training', 'immediately_before_training', 'immediately_after_training',
];

const MEAL_TYPES_BASE = [
  'recien_levantado', 'breakfast', 'media_manana', 'lunch', 'snack', 'dinner', 'antes_de_dormir',
];

exports.up = async (knex) => {
  await setMealTypeCheck(knex, 'nutrition_plan_template_meals', 'chk_nptm_meal_type', MEAL_TYPES_WITH_TRAINING);
  await setMealTypeCheck(knex, 'member_nutrition_plan_meals', 'chk_mnpm_meal_type', MEAL_TYPES_WITH_TRAINING);
};

exports.down = async (knex) => {
  // Irreversible: rows using the new training values are nulled out here and
  // cannot be distinguished from originally-NULL rows if up() is re-applied later.
  await knex('nutrition_plan_template_meals')
    .whereIn('meal_type', ['two_three_hours_before_training', 'immediately_before_training', 'immediately_after_training'])
    .update({ meal_type: null });
  await knex('member_nutrition_plan_meals')
    .whereIn('meal_type', ['two_three_hours_before_training', 'immediately_before_training', 'immediately_after_training'])
    .update({ meal_type: null });

  await setMealTypeCheck(knex, 'nutrition_plan_template_meals', 'chk_nptm_meal_type', MEAL_TYPES_BASE);
  await setMealTypeCheck(knex, 'member_nutrition_plan_meals', 'chk_mnpm_meal_type', MEAL_TYPES_BASE);
};
