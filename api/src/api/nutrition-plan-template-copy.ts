import { Tx } from '../infra/db';

/**
 * Deep-copies a Nutrition Plan Template's content — days → meals → meal items,
 * restrictions and goals — from `srcId` onto the gym-owned template `newId`.
 * The one copy Duplicate, Clone and Import (#3333) share, so a column added to
 * the content is copied by all three. Food references are re-resolved through
 * the Base/gym split (#1849 stage F5): a gym-owned food stays in the old column,
 * a System food in the Base one.
 */
export async function copyTemplateContentTx(tx: Tx, srcId: number | string, newId: number, gymId: string): Promise<void> {
  const { rows: days } = await tx.query(
    'SELECT * FROM nutrition_plan_template_days WHERE nutrition_plan_template_id = ? ORDER BY position ASC',
    [srcId],
  );
  for (const day of days) {
    const { insertId: newDayId } = await tx.query(
      'INSERT INTO nutrition_plan_template_days (gym_id, nutrition_plan_template_id, weekday, position) VALUES (?, ?, ?, ?)',
      [gymId, newId, day.weekday, day.position],
    );
    const { rows: meals } = await tx.query(
      'SELECT * FROM nutrition_plan_template_meals WHERE nutrition_plan_template_day_id = ? ORDER BY position ASC',
      [day.id],
    );
    for (const meal of meals) {
      const { insertId: newMealId } = await tx.query(
        'INSERT INTO nutrition_plan_template_meals (gym_id, nutrition_plan_template_day_id, meal_type, base_meal_id, display_name, notes, position) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [gymId, newDayId, meal.meal_type ?? null, meal.base_meal_id ?? null, meal.display_name, meal.notes ?? null, meal.position],
      );
      const { rows: items } = await tx.query(
        'SELECT * FROM nutrition_plan_template_meal_items WHERE meal_id = ? ORDER BY position ASC',
        [meal.id],
      );
      for (const item of items) {
        await tx.query(
          'INSERT INTO nutrition_plan_template_meal_items (gym_id, meal_id, nutrition_library_item_id, base_nutrition_library_item_id, component_type, quantity, unit, position) VALUES (?, ?, (SELECT id FROM nutrition_library_items WHERE id = ? AND gym_id IS NOT NULL), (SELECT id FROM base_nutrition_library_items WHERE id = ?), ?, ?, ?, ?)',
          [gymId, newMealId, (item.base_nutrition_library_item_id ?? item.nutrition_library_item_id), (item.base_nutrition_library_item_id ?? item.nutrition_library_item_id), item.component_type, item.quantity ?? null, item.unit ?? null, item.position],
        );
      }
    }
  }

  const { rows: restrictions } = await tx.query(
    'SELECT * FROM nutrition_plan_template_restrictions WHERE nutrition_plan_template_id = ? ORDER BY position ASC',
    [srcId],
  );
  for (const r of restrictions) {
    await tx.query(
      'INSERT INTO nutrition_plan_template_restrictions (gym_id, nutrition_plan_template_id, nutrition_library_item_id, base_nutrition_library_item_id, applies_all_days, position) VALUES (?, ?, (SELECT id FROM nutrition_library_items WHERE id = ? AND gym_id IS NOT NULL), (SELECT id FROM base_nutrition_library_items WHERE id = ?), ?, ?)',
      [gymId, newId, (r.base_nutrition_library_item_id ?? r.nutrition_library_item_id), (r.base_nutrition_library_item_id ?? r.nutrition_library_item_id), r.applies_all_days, r.position],
    );
  }

  const { rows: goals } = await tx.query(
    'SELECT * FROM nutrition_plan_template_goals WHERE nutrition_plan_template_id = ? ORDER BY position ASC',
    [srcId],
  );
  for (const g of goals) {
    await tx.query(
      'INSERT INTO nutrition_plan_template_goals (gym_id, nutrition_plan_template_id, item_name, quantity, unit, frequency, applies_all_days, position, nutrition_library_item_id, base_nutrition_library_item_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT id FROM nutrition_library_items WHERE id = ? AND gym_id IS NOT NULL), (SELECT id FROM base_nutrition_library_items WHERE id = ?))',
      [gymId, newId, g.item_name, g.quantity, g.unit, g.frequency, g.applies_all_days, g.position, (g.base_nutrition_library_item_id ?? g.nutrition_library_item_id ?? null), (g.base_nutrition_library_item_id ?? g.nutrition_library_item_id ?? null)],
    );
  }
}
