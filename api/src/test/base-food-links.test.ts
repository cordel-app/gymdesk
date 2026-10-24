// #1849 stages F3-F5 (Foods): the five tables that reference a Food by id reference a System food
// through base_nutrition_library_item_id alone (migration 332).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { FOOD_REFERENCE_TABLES, baseFoodLinkChecks } from '../domain/baseFoodLinkAudit';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestBaseFood, createTestGym, createTestMembership, deleteTestBaseFoods, request } from './helpers';

let gymId: string;
let templateId: number;
let systemFoodId: number;
let ownFoodId: number;

async function auditCounts() {
  const { checks, params } = baseFoodLinkChecks(gymId);
  const out: Record<string, number> = {};
  for (const [i, c] of checks.entries()) {
    const { rows } = await db.query<{ n: number }>(c.sql, params[i]);
    out[c.key] = Number(rows[0].n);
  }
  return out;
}

beforeAll(async () => {
  gymId = await createTestGym();
  await createTestMembership(gymId, 'admin');
  systemFoodId = await createTestBaseFood('Test Food Links System');
  const own = await db.query("INSERT INTO nutrition_library_items (gym_id, name, status) VALUES (?, 'Test Food Links Own', 'active')", [gymId]);
  ownFoodId = own.insertId as number;
  const t = await db.query("INSERT INTO nutrition_plan_templates (gym_id, name, status) VALUES (?, 'Test Food Links Template', 'active')", [gymId]);
  templateId = t.insertId as number;
});

afterAll(async () => {
  await db.query('DELETE FROM nutrition_plan_template_goals WHERE nutrition_plan_template_id = ?', [templateId]);
  await db.query('DELETE FROM nutrition_plan_templates WHERE id = ?', [templateId]);
  await deleteTestBaseFoods("name LIKE 'Test Food Links System%'");
  await cleanupTestGyms();
  await db.end();
});

describe('base_nutrition_library_item_id (#1849 stage F5)', () => {
  it('the old column is nullable everywhere and keeps its FK for gym-owned foods; the mandatory tables carry the exactly-one CHECK', async () => {
    const { rows } = await db.query<any>(
      `SELECT k.TABLE_NAME AS t, k.COLUMN_NAME AS c, r.DELETE_RULE AS rule
         FROM information_schema.KEY_COLUMN_USAGE k
         JOIN information_schema.REFERENTIAL_CONSTRAINTS r
           ON r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.CONSTRAINT_SCHEMA = k.TABLE_SCHEMA
        WHERE k.TABLE_SCHEMA = DATABASE()
          AND k.REFERENCED_TABLE_NAME IN ('base_nutrition_library_items', 'nutrition_library_items')
          AND k.TABLE_NAME IN (${FOOD_REFERENCE_TABLES.map((t) => `'${t}'`).join(',')})`,
    );
    const nullable = await db.query<any>(
      `SELECT TABLE_NAME AS t, IS_NULLABLE AS n FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'nutrition_library_item_id'
          AND TABLE_NAME IN (${FOOD_REFERENCE_TABLES.map((t) => `'${t}'`).join(',')})`,
    );
    for (const t of FOOD_REFERENCE_TABLES) {
      const rule = t.endsWith('_goals') ? 'SET NULL' : 'RESTRICT';
      expect(rows.find((r: any) => r.t === t && r.c === 'nutrition_library_item_id')?.rule, `${t} old`).toBe(rule);
      expect(rows.find((r: any) => r.t === t && r.c === 'base_nutrition_library_item_id')?.rule, `${t} new`).toBe(rule);
      expect(nullable.rows.find((r: any) => r.t === t)?.n, `${t} nullable`).toBe('YES');
    }
    const checks = await db.query<any>(
      `SELECT tc.TABLE_NAME AS t FROM information_schema.TABLE_CONSTRAINTS tc
        WHERE tc.TABLE_SCHEMA = DATABASE() AND tc.CONSTRAINT_TYPE = 'CHECK' AND tc.CONSTRAINT_NAME LIKE 'chk\\_%\\_one\\_food\\_ref'`,
    );
    expect(checks.rows.map((r: any) => r.t).sort()).toEqual([
      'member_nutrition_plan_meal_items', 'member_nutrition_plan_restrictions', 'nutrition_plan_template_meal_items', 'nutrition_plan_template_restrictions',
    ]);
  });

  it('a meal item references exactly one food: both and neither are refused by the database', async () => {
    const day = await db.query('INSERT INTO nutrition_plan_template_days (gym_id, nutrition_plan_template_id, weekday, position) VALUES (?, ?, 1, 0)', [gymId, templateId]);
    const meal = await db.query("INSERT INTO nutrition_plan_template_meals (gym_id, nutrition_plan_template_day_id, display_name, position) VALUES (?, ?, 'M', 1)", [gymId, day.insertId]);
    const insert = (old: number | null, base: number | null) => db.query(
      "INSERT INTO nutrition_plan_template_meal_items (gym_id, meal_id, nutrition_library_item_id, base_nutrition_library_item_id, component_type, position) VALUES (?, ?, ?, ?, 'main_dish', 1)",
      [gymId, meal.insertId, old, base],
    );
    await expect(insert(ownFoodId, systemFoodId)).rejects.toThrow();
    await expect(insert(null, null)).rejects.toThrow();
    await insert(ownFoodId, null);
    await insert(null, systemFoodId);
    const counts = await auditCounts();
    for (const [key, n] of Object.entries(counts)) expect(n, key).toBe(0);
  });

  it('the audit flags a goal naming both foods and a reference to a legacy System food', async () => {
    const legacy = await db.query("INSERT INTO nutrition_library_items (gym_id, name, status) VALUES (NULL, 'Test Food Links Legacy', 'active')");
    try {
      await db.query(
        `INSERT INTO nutrition_plan_template_goals (gym_id, nutrition_plan_template_id, item_name, quantity, unit, nutrition_library_item_id, base_nutrition_library_item_id)
         VALUES (?, ?, 'protein', 1, 'g', ?, ?), (?, ?, 'water', 1, 'l', ?, NULL)`,
        [gymId, templateId, ownFoodId, systemFoodId, gymId, templateId, legacy.insertId],
      );
      const counts = await auditCounts();
      expect(counts.nutrition_plan_template_goals_not_exactly_one).toBe(1);
      expect(counts.nutrition_plan_template_goals_references_legacy_system_food).toBe(1);
    } finally {
      await db.query('DELETE FROM nutrition_plan_template_goals WHERE nutrition_plan_template_id = ?', [templateId]);
      await db.query('DELETE FROM nutrition_library_items WHERE id = ?', [legacy.insertId]);
    }
  });
});

describe('writers and readers use base_nutrition_library_item_id (#1849 stages F4-F5)', () => {
  const asGym = () => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': gymId });

  it('a goal illustrated by a System food stores the Base reference alone; a gym-owned food stores only the old one', async () => {
    await db.query('DELETE FROM nutrition_plan_template_goals WHERE nutrition_plan_template_id = ?', [templateId]);
    const sys = await request.post(`/nutrition-plan-templates/${templateId}/goals`).set(asGym())
      .send({ item_name: 'protein', quantity: 1, unit: 'g', nutrition_library_item_id: systemFoodId });
    expect(sys.status).toBe(201);
    expect(sys.body.nutrition_library_item_id).toBe(systemFoodId);
    const own = await request.post(`/nutrition-plan-templates/${templateId}/goals`).set(asGym())
      .send({ item_name: 'water', quantity: 1, unit: 'l', nutrition_library_item_id: ownFoodId });
    expect(own.status).toBe(201);
    const { rows } = await db.query<any>(
      'SELECT nutrition_library_item_id AS old, base_nutrition_library_item_id AS base FROM nutrition_plan_template_goals WHERE nutrition_plan_template_id = ? ORDER BY id', [templateId]);
    expect(rows).toEqual([{ old: null, base: systemFoodId }, { old: ownFoodId, base: null }]);
  });

  it('editing the illustration moves the reference to the right column, and clearing it clears both', async () => {
    const { rows } = await db.query<any>('SELECT id FROM nutrition_plan_template_goals WHERE nutrition_plan_template_id = ? ORDER BY id', [templateId]);
    const gid = rows[1].id; // currently the gym-owned one
    const put = await request.put(`/nutrition-plan-templates/${templateId}/goals/${gid}`).set(asGym())
      .send({ nutrition_library_item_id: systemFoodId });
    expect(put.status).toBe(200);
    const after = await db.query<any>('SELECT nutrition_library_item_id AS old, base_nutrition_library_item_id AS base FROM nutrition_plan_template_goals WHERE id = ?', [gid]);
    expect(after.rows[0]).toEqual({ old: null, base: systemFoodId });
    const clear = await request.put(`/nutrition-plan-templates/${templateId}/goals/${gid}`).set(asGym()).send({ nutrition_library_item_id: null });
    expect(clear.status).toBe(200);
    const cleared = await db.query<any>('SELECT nutrition_library_item_id AS old, base_nutrition_library_item_id AS base FROM nutrition_plan_template_goals WHERE id = ?', [gid]);
    expect(cleared.rows[0]).toEqual({ old: null, base: null });
  });

  it('readers resolve the food through the Base column alone (the state the cut-over leaves behind)', async () => {
    const { rows } = await db.query<any>('SELECT id FROM nutrition_plan_template_goals WHERE nutrition_plan_template_id = ? ORDER BY id', [templateId]);
    await db.query('UPDATE nutrition_plan_template_goals SET nutrition_library_item_id = NULL, base_nutrition_library_item_id = ? WHERE id = ?', [systemFoodId, rows[0].id]);
    const res = await request.get(`/nutrition-plan-templates/${templateId}/goals`).set(asGym());
    expect(res.status).toBe(200);
    const goal = res.body.find((g: any) => g.id === rows[0].id);
    expect(goal.nutrition_library_item_id).toBe(systemFoodId);
    expect(goal.illustration_name).toBe('Test Food Links System');
  });
});
