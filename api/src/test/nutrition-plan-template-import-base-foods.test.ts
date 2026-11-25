// #3338: importing System Nutrition Plan Templates keeps their System (Base) Food
// references. Base Foods are shared Cordel entities, already available to every gym,
// so the import copies no food into the gym's Nutrition Library and remaps nothing:
// every meal item, restriction and goal illustration of the gym copy still names the
// same Base Food through `base_nutrition_library_item_id`, never a gym food id.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestBaseFood, createTestGym, createTestMembership,
  deleteTestBaseFoods, request,
} from './helpers';

let gymId: string;
let sharedFoodId: number;
let otherFoodId: number;
let firstBaseId: number;
let secondBaseId: number;
const baseIds: number[] = [];
const stamp = Date.now();

const as = (gym: string) => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': gym });

async function insertBaseTemplate(name: string, foods: number[]): Promise<number> {
  const { insertId: templateId } = await db.query(
    "INSERT INTO nutrition_plan_templates (gym_id, name, num_days, status) VALUES (NULL, ?, 1, 'active')",
    [name],
  );
  baseIds.push(templateId);
  const { insertId: dayId } = await db.query(
    'INSERT INTO nutrition_plan_template_days (gym_id, nutrition_plan_template_id, weekday, position) VALUES (NULL, ?, 1, 1)',
    [templateId],
  );
  const { rows: meal } = await db.query<{ id: number; slug: string }>('SELECT id, slug FROM base_meals ORDER BY id LIMIT 1');
  const { insertId: mealId } = await db.query(
    'INSERT INTO nutrition_plan_template_meals (gym_id, nutrition_plan_template_day_id, meal_type, base_meal_id, display_name, position) VALUES (NULL, ?, ?, ?, ?, 1)',
    [dayId, meal[0].slug, meal[0].id, 'Breakfast'],
  );
  for (const [i, foodId] of foods.entries()) {
    await db.query(
      "INSERT INTO nutrition_plan_template_meal_items (gym_id, meal_id, base_nutrition_library_item_id, component_type, quantity, unit, position) VALUES (NULL, ?, ?, 'main_dish', 100, 'g', ?)",
      [mealId, foodId, i + 1],
    );
  }
  await db.query(
    'INSERT INTO nutrition_plan_template_restrictions (gym_id, nutrition_plan_template_id, base_nutrition_library_item_id, applies_all_days, position) VALUES (NULL, ?, ?, 1, 1)',
    [templateId, foods[0]],
  );
  await db.query(
    "INSERT INTO nutrition_plan_template_goals (gym_id, nutrition_plan_template_id, item_name, quantity, unit, frequency, applies_all_days, position, base_nutrition_library_item_id) VALUES (NULL, ?, 'water', 2, 'l', 'daily', 1, 1, ?)",
    [templateId, foods[0]],
  );
  return templateId;
}

beforeAll(async () => {
  gymId = await createTestGym('NPT Base Foods Gym');
  await createTestMembership(gymId, 'admin');
  sharedFoodId = await createTestBaseFood(`NPT Shared Food ${stamp}`);
  otherFoodId = await createTestBaseFood(`NPT Other Food ${stamp}`);
  // Both templates use the shared food; the first also uses a second one.
  firstBaseId = await insertBaseTemplate(`NPT Base Foods One ${stamp}`, [sharedFoodId, otherFoodId]);
  secondBaseId = await insertBaseTemplate(`NPT Base Foods Two ${stamp}`, [sharedFoodId]);
});

afterAll(async () => {
  await db.query(`DELETE FROM nutrition_plan_templates WHERE id IN (${baseIds.map(() => '?').join(',')})`, baseIds);
  await cleanupTestGyms();
  await deleteTestBaseFoods('id IN (?, ?)', [sharedFoodId, otherFoodId]);
  await db.end();
});

describe('POST /nutrition-plan-templates/import — System Food references (#3338)', () => {
  let copyIds: number[] = [];

  it('imports several templates at once and copies no food into the gym', async () => {
    const before = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM nutrition_library_items WHERE gym_id = ?', [gymId]);
    const res = await request.post('/nutrition-plan-templates/import').set(as(gymId))
      .send({ baseTemplateIds: [firstBaseId, secondBaseId] });
    expect(res.status).toBe(201);
    expect(res.body.imported).toHaveLength(2);
    copyIds = res.body.imported.map((t: any) => t.id);

    const after = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM nutrition_library_items WHERE gym_id = ?', [gymId]);
    expect(Number(after.rows[0].n)).toBe(Number(before.rows[0].n));
  });

  it('keeps every meal item, restriction and goal on the same Base Food, never a gym food id', async () => {
    const placeholders = copyIds.map(() => '?').join(',');
    const { rows: items } = await db.query<any>(
      `SELECT i.gym_id, i.nutrition_library_item_id, i.base_nutrition_library_item_id
         FROM nutrition_plan_template_meal_items i
         JOIN nutrition_plan_template_meals m ON m.id = i.meal_id
         JOIN nutrition_plan_template_days d ON d.id = m.nutrition_plan_template_day_id
        WHERE d.nutrition_plan_template_id IN (${placeholders})
        ORDER BY i.base_nutrition_library_item_id`,
      copyIds,
    );
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item.gym_id).toBe(gymId);
      expect(item.nutrition_library_item_id).toBeNull();
    }
    expect(items.map((i: any) => i.base_nutrition_library_item_id).sort())
      .toEqual([sharedFoodId, sharedFoodId, otherFoodId].sort());

    const { rows: restrictions } = await db.query<any>(
      `SELECT nutrition_library_item_id, base_nutrition_library_item_id FROM nutrition_plan_template_restrictions WHERE nutrition_plan_template_id IN (${placeholders})`,
      copyIds,
    );
    expect(restrictions).toHaveLength(2);
    for (const r of restrictions) expect(r).toEqual({ nutrition_library_item_id: null, base_nutrition_library_item_id: sharedFoodId });

    const { rows: goals } = await db.query<any>(
      `SELECT nutrition_library_item_id, base_nutrition_library_item_id FROM nutrition_plan_template_goals WHERE nutrition_plan_template_id IN (${placeholders})`,
      copyIds,
    );
    expect(goals).toHaveLength(2);
    for (const g of goals) expect(g).toEqual({ nutrition_library_item_id: null, base_nutrition_library_item_id: sharedFoodId });
  });

  it('reads the imported copy back with its Base Meal and the shared foods resolved', async () => {
    const h = await request.get(`/nutrition-plan-templates/${copyIds[0]}/hierarchy`).set(as(gymId));
    expect(h.status).toBe(200);
    const meal = h.body.days[0].meals[0];
    expect(meal.base_meal_id).toEqual(expect.any(Number));
    expect(meal.items.map((i: any) => i.nutrition_library_item_id).sort())
      .toEqual([sharedFoodId, otherFoodId].sort());
    expect(h.body.restrictions[0].nutrition_library_item_id).toBe(sharedFoodId);
  });
});
