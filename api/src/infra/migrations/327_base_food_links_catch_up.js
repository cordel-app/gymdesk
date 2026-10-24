/**
 * #1849 stage F4 (Foods) — re-runs migration 326's idempotent backfill for the rows
 * written between that migration and the deploy of the writers that now set
 * `base_nutrition_library_item_id` themselves (every plan write and copy, and the goal
 * illustration edits). A row pointing at a System food gets the Base reference (the
 * ids are equal); a row of a gym-owned food is left alone. Nothing else changes.
 */
const TABLES = [
  'member_nutrition_plan_meal_items',
  'member_nutrition_plan_restrictions',
  'nutrition_plan_template_meal_items',
  'member_nutrition_plan_goals',
  'nutrition_plan_template_goals',
];

exports.up = async (knex) => {
  for (const table of TABLES) {
    await knex.raw(`
      UPDATE ${table} t
        JOIN nutrition_library_items i ON i.id = t.nutrition_library_item_id AND i.gym_id IS NULL
         SET t.base_nutrition_library_item_id = i.id
       WHERE t.base_nutrition_library_item_id IS NULL
    `);
  }
};

exports.down = async () => {};
