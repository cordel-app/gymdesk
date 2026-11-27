import { Tx } from '../infra/db';

/**
 * A Nutrition Plan Template's content — days → meals → meal items,
 * restrictions and goals — as plain rows, in position order. What
 * `readTemplateContentTx()` reads and `writeTemplateContentTx()` writes, so the
 * copy (Duplicate, Clone, Import, #3333) and the edit-session restore (#3482)
 * are one definition of "the content": a column added to it is carried by all.
 */
export interface TemplateContent {
  days: Array<{
    weekday: number;
    position: number;
    meals: Array<{
      meal_type: string | null;
      base_meal_id: number | null;
      display_name: string | null;
      notes: string | null;
      position: number;
      items: Array<{
        food_id: number | null;
        component_type: string;
        quantity: number | string | null;
        unit: string | null;
        position: number;
      }>;
    }>;
  }>;
  restrictions: Array<{ food_id: number | null; applies_all_days: number; position: number }>;
  goals: Array<{
    item_name: string;
    quantity: number | string | null;
    unit: string | null;
    frequency: string | null;
    applies_all_days: number;
    position: number;
    food_id: number | null;
  }>;
}

/** The food a row names, Base or gym-owned (#1849 stage F5: ids are disjoint). */
export function foodId(row: { base_nutrition_library_item_id?: number | null; nutrition_library_item_id?: number | null }): number | null {
  return row.base_nutrition_library_item_id ?? row.nutrition_library_item_id ?? null;
}

export async function readTemplateContentTx(tx: Tx, templateId: number | string): Promise<TemplateContent> {
  const { rows: days } = await tx.query(
    'SELECT * FROM nutrition_plan_template_days WHERE nutrition_plan_template_id = ? ORDER BY position ASC, id ASC',
    [templateId],
  );
  const content: TemplateContent = { days: [], restrictions: [], goals: [] };
  for (const day of days) {
    const { rows: meals } = await tx.query(
      'SELECT * FROM nutrition_plan_template_meals WHERE nutrition_plan_template_day_id = ? ORDER BY position ASC, id ASC',
      [day.id],
    );
    const outMeals: TemplateContent['days'][number]['meals'] = [];
    for (const meal of meals) {
      const { rows: items } = await tx.query(
        'SELECT * FROM nutrition_plan_template_meal_items WHERE meal_id = ? ORDER BY position ASC, id ASC',
        [meal.id],
      );
      outMeals.push({
        meal_type: meal.meal_type ?? null,
        base_meal_id: meal.base_meal_id ?? null,
        display_name: meal.display_name ?? null,
        notes: meal.notes ?? null,
        position: meal.position,
        items: items.map((item: any) => ({
          food_id: foodId(item),
          component_type: item.component_type,
          quantity: item.quantity ?? null,
          unit: item.unit ?? null,
          position: item.position,
        })),
      });
    }
    content.days.push({ weekday: day.weekday, position: day.position, meals: outMeals });
  }

  const { rows: restrictions } = await tx.query(
    'SELECT * FROM nutrition_plan_template_restrictions WHERE nutrition_plan_template_id = ? ORDER BY position ASC, id ASC',
    [templateId],
  );
  content.restrictions = restrictions.map((r: any) => ({
    food_id: foodId(r), applies_all_days: r.applies_all_days, position: r.position,
  }));

  const { rows: goals } = await tx.query(
    'SELECT * FROM nutrition_plan_template_goals WHERE nutrition_plan_template_id = ? ORDER BY position ASC, id ASC',
    [templateId],
  );
  content.goals = goals.map((g: any) => ({
    item_name: g.item_name,
    quantity: g.quantity ?? null,
    unit: g.unit ?? null,
    frequency: g.frequency ?? null,
    applies_all_days: g.applies_all_days,
    position: g.position,
    food_id: foodId(g),
  }));
  return content;
}

/**
 * Writes `content` onto the gym-owned template `templateId`. Food references
 * are re-resolved through the Base/gym split (#1849 stage F5): a gym-owned food
 * stays in the old column, a System food in the Base one.
 */
export async function writeTemplateContentTx(tx: Tx, content: TemplateContent, templateId: number | string, gymId: string): Promise<void> {
  for (const day of content.days) {
    const { insertId: dayId } = await tx.query(
      'INSERT INTO nutrition_plan_template_days (gym_id, nutrition_plan_template_id, weekday, position) VALUES (?, ?, ?, ?)',
      [gymId, templateId, day.weekday, day.position],
    );
    for (const meal of day.meals) {
      const { insertId: mealId } = await tx.query(
        'INSERT INTO nutrition_plan_template_meals (gym_id, nutrition_plan_template_day_id, meal_type, base_meal_id, display_name, notes, position) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [gymId, dayId, meal.meal_type, meal.base_meal_id, meal.display_name, meal.notes, meal.position],
      );
      for (const item of meal.items) {
        await tx.query(
          'INSERT INTO nutrition_plan_template_meal_items (gym_id, meal_id, nutrition_library_item_id, base_nutrition_library_item_id, component_type, quantity, unit, position) VALUES (?, ?, (SELECT id FROM nutrition_library_items WHERE id = ? AND gym_id IS NOT NULL), (SELECT id FROM base_nutrition_library_items WHERE id = ?), ?, ?, ?, ?)',
          [gymId, mealId, item.food_id, item.food_id, item.component_type, item.quantity, item.unit, item.position],
        );
      }
    }
  }

  for (const r of content.restrictions) {
    await tx.query(
      'INSERT INTO nutrition_plan_template_restrictions (gym_id, nutrition_plan_template_id, nutrition_library_item_id, base_nutrition_library_item_id, applies_all_days, position) VALUES (?, ?, (SELECT id FROM nutrition_library_items WHERE id = ? AND gym_id IS NOT NULL), (SELECT id FROM base_nutrition_library_items WHERE id = ?), ?, ?)',
      [gymId, templateId, r.food_id, r.food_id, r.applies_all_days, r.position],
    );
  }

  for (const g of content.goals) {
    await tx.query(
      'INSERT INTO nutrition_plan_template_goals (gym_id, nutrition_plan_template_id, item_name, quantity, unit, frequency, applies_all_days, position, nutrition_library_item_id, base_nutrition_library_item_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT id FROM nutrition_library_items WHERE id = ? AND gym_id IS NOT NULL), (SELECT id FROM base_nutrition_library_items WHERE id = ?))',
      [gymId, templateId, g.item_name, g.quantity, g.unit, g.frequency, g.applies_all_days, g.position, g.food_id, g.food_id],
    );
  }
}

/** Deletes a template's content; meals and meal items cascade from their day. */
export async function clearTemplateContentTx(tx: Tx, templateId: number | string): Promise<void> {
  await tx.query('DELETE FROM nutrition_plan_template_days WHERE nutrition_plan_template_id = ?', [templateId]);
  await tx.query('DELETE FROM nutrition_plan_template_restrictions WHERE nutrition_plan_template_id = ?', [templateId]);
  await tx.query('DELETE FROM nutrition_plan_template_goals WHERE nutrition_plan_template_id = ?', [templateId]);
}

/**
 * Deep-copies a Nutrition Plan Template's content from `srcId` onto the
 * gym-owned template `newId`. The one copy Duplicate, Clone and Import share.
 */
export async function copyTemplateContentTx(tx: Tx, srcId: number | string, newId: number, gymId: string): Promise<void> {
  await writeTemplateContentTx(tx, await readTemplateContentTx(tx, srcId), newId, gymId);
}
