/**
 * #1624: widen chk_mnpmi_comp (migration 105) from four component types to the
 * template table's seven (chk_nptmi_component_type, migration 111), so an
 * assigned Nutrition Plan offers Drink, Dessert and Other like a template.
 * The list lives in api/src/domain/nutritionComponentTypes.ts. A superset, so
 * no stored row can violate it.
 */
exports.up = async (knex) => {
  await knex.raw('ALTER TABLE member_nutrition_plan_meal_items DROP CHECK chk_mnpmi_comp');
  await knex.raw(
    'ALTER TABLE member_nutrition_plan_meal_items ' +
    "ADD CONSTRAINT chk_mnpmi_comp CHECK (component_type IN ('main_dish','side','sauce','drink','dessert','other','additional'))",
  );
};

exports.down = async (knex) => {
  await knex.raw(
    "UPDATE member_nutrition_plan_meal_items SET component_type = 'additional' " +
    "WHERE component_type IN ('drink','dessert','other')",
  );
  await knex.raw('ALTER TABLE member_nutrition_plan_meal_items DROP CHECK chk_mnpmi_comp');
  await knex.raw(
    'ALTER TABLE member_nutrition_plan_meal_items ' +
    "ADD CONSTRAINT chk_mnpmi_comp CHECK (component_type IN ('main_dish','side','sauce','additional'))",
  );
};
