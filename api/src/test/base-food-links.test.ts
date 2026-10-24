// #1849 stages F3-F4 (Foods): migration 326 adds base_nutrition_library_item_id to the five
// tables that reference a Food by id, backfills it for System foods and changes nothing else.

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

describe('base_nutrition_library_item_id (#1849 stage F3)', () => {
  it('exists on all five tables with the rule of the FK it will replace', async () => {
    const { rows } = await db.query<any>(
      `SELECT k.TABLE_NAME AS t, k.COLUMN_NAME AS c, r.DELETE_RULE AS rule
         FROM information_schema.KEY_COLUMN_USAGE k
         JOIN information_schema.REFERENTIAL_CONSTRAINTS r
           ON r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.CONSTRAINT_SCHEMA = k.TABLE_SCHEMA
        WHERE k.TABLE_SCHEMA = DATABASE()
          AND k.REFERENCED_TABLE_NAME IN ('base_nutrition_library_items', 'nutrition_library_items')
          AND k.TABLE_NAME IN (${FOOD_REFERENCE_TABLES.map((t) => `'${t}'`).join(',')})`,
    );
    for (const t of FOOD_REFERENCE_TABLES) {
      const goal = t.endsWith('_goals');
      const rule = goal ? 'SET NULL' : 'RESTRICT';
      expect(rows.find((r: any) => r.t === t && r.c === 'nutrition_library_item_id')?.rule, `${t} old`).toBe(rule);
      expect(rows.find((r: any) => r.t === t && r.c === 'base_nutrition_library_item_id')?.rule, `${t} new`).toBe(rule);
    }
  });

  it('the audit flags an unlinked System reference and passes once backfilled; a gym-owned food never gets a Base link', async () => {
    await db.query(
      `INSERT INTO nutrition_plan_template_goals (gym_id, nutrition_plan_template_id, item_name, quantity, unit, nutrition_library_item_id)
       VALUES (?, ?, 'protein', 1, 'g', ?), (?, ?, 'water', 1, 'l', ?)`,
      [gymId, templateId, systemFoodId, gymId, templateId, ownFoodId],
    );
    expect((await auditCounts()).nutrition_plan_template_goals_system_unlinked).toBe(1);

    // The migration's backfill statement, as stage F4 re-runs it.
    for (const table of FOOD_REFERENCE_TABLES) {
      await db.query(
        `UPDATE ${table} t JOIN nutrition_library_items i ON i.id = t.nutrition_library_item_id AND i.gym_id IS NULL
            SET t.base_nutrition_library_item_id = i.id WHERE t.base_nutrition_library_item_id IS NULL`,
      );
    }
    const counts = await auditCounts();
    for (const [key, n] of Object.entries(counts)) expect(n, key).toBe(0);
    const { rows } = await db.query<any>(
      'SELECT nutrition_library_item_id AS old, base_nutrition_library_item_id AS base FROM nutrition_plan_template_goals WHERE nutrition_plan_template_id = ? ORDER BY id', [templateId]);
    expect(rows[0]).toEqual({ old: systemFoodId, base: systemFoodId });
    expect(rows[1]).toEqual({ old: ownFoodId, base: null });
  });

  it('a Base food that a plan references cannot be hard-deleted on the RESTRICT tables, and the old FK is untouched', async () => {
    const { rows } = await db.query<any>(
      `SELECT COUNT(*) AS n FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'nutrition_library_item_id'
          AND REFERENCED_TABLE_NAME = 'nutrition_library_items'
          AND TABLE_NAME IN (${FOOD_REFERENCE_TABLES.map((t) => `'${t}'`).join(',')})`,
    );
    expect(Number(rows[0].n)).toBe(5);
  });
});

describe('writers and readers use base_nutrition_library_item_id (#1849 stage F4)', () => {
  const asGym = () => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': gymId });

  it('a goal illustrated by a System food stores both references; a gym-owned food stores only the old one', async () => {
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
    expect(rows).toEqual([{ old: systemFoodId, base: systemFoodId }, { old: ownFoodId, base: null }]);
  });

  it('editing the illustration moves both references, and clearing it clears both', async () => {
    const { rows } = await db.query<any>('SELECT id FROM nutrition_plan_template_goals WHERE nutrition_plan_template_id = ? ORDER BY id', [templateId]);
    const gid = rows[1].id; // currently the gym-owned one
    const put = await request.put(`/nutrition-plan-templates/${templateId}/goals/${gid}`).set(asGym())
      .send({ nutrition_library_item_id: systemFoodId });
    expect(put.status).toBe(200);
    const after = await db.query<any>('SELECT nutrition_library_item_id AS old, base_nutrition_library_item_id AS base FROM nutrition_plan_template_goals WHERE id = ?', [gid]);
    expect(after.rows[0]).toEqual({ old: systemFoodId, base: systemFoodId });
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
