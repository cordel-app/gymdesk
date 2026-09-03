/**
 * #294: Extend component_type CHECK on nutrition_plan_template_meal_items to
 * include all nutrition_library_items categories: drink, dessert, other.
 * Keeps 'additional' for backward compatibility with existing rows.
 */
exports.up = async (knex) => {
  await knex.raw(
    'ALTER TABLE nutrition_plan_template_meal_items DROP CHECK chk_nptmi_component_type',
  ).catch(() => {});
  await knex.raw(
    "ALTER TABLE nutrition_plan_template_meal_items " +
    "ADD CONSTRAINT chk_nptmi_component_type " +
    "CHECK (component_type IN ('main_dish','side','sauce','drink','dessert','other','additional'))",
  );
};

exports.down = async (knex) => {
  await knex.raw(
    'ALTER TABLE nutrition_plan_template_meal_items DROP CHECK chk_nptmi_component_type',
  ).catch(() => {});
  await knex.raw(
    "ALTER TABLE nutrition_plan_template_meal_items " +
    "ADD CONSTRAINT chk_nptmi_component_type " +
    "CHECK (component_type IN ('main_dish','side','sauce','additional'))",
  ).catch(() => {});
};
