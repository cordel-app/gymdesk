// #1849 stage F1 (Foods): migration 324 copies the System Foods and their junction
// rows into the base_nutrition_library_* tables, keeping ids, and leaves the legacy
// rows untouched.

import { afterAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';

afterAll(async () => {
  await db.end();
});


describe('base_nutrition_library_items copy (#1849 stage F1)', () => {
  // Name only: other test files edit a System food's description or image while this runs.
  it('holds every System food that was copied under its original id and name', async () => {
    const { rows: legacy } = await db.query<any>(
      `SELECT id, name FROM nutrition_library_items
        WHERE gym_id IS NULL AND id IN (SELECT id FROM base_nutrition_library_items) ORDER BY id`,
    );
    expect(legacy.length).toBeGreaterThan(0);
    const { rows: base } = await db.query<any>(
      `SELECT id, name FROM base_nutrition_library_items
        WHERE id IN (SELECT id FROM nutrition_library_items WHERE gym_id IS NULL) ORDER BY id`,
    );
    expect(base).toEqual(legacy);
  });

  it('copies the categories, qualities and translations of every copied food', async () => {
    const checks: Array<[string, string, string]> = [
      ['nutrition_library_item_categories', 'base_nutrition_library_item_categories', 'category_id'],
      ['nutrition_library_item_qualities', 'base_nutrition_library_item_qualities', 'quality_id'],
      ['nutrition_library_item_translations', 'base_nutrition_library_item_translations', 'locale'],
      ['nutrition_library_item_description_translations', 'base_nutrition_library_item_description_translations', 'locale'],
    ];
    for (const [legacyTable, baseTable, col] of checks) {
      const { rows } = await db.query<any>(
        `SELECT COUNT(*) AS missing FROM ${legacyTable} l
           JOIN base_nutrition_library_items b ON b.id = l.item_id
           LEFT JOIN ${baseTable} t ON t.item_id = l.item_id AND t.${col} = l.${col}
          WHERE t.item_id IS NULL`,
      );
      expect(Number(rows[0].missing), `${baseTable} is missing rows`).toBe(0);
    }
  });

  it('leaves the legacy System rows in place and the plan foreign keys on them', async () => {
    const { rows } = await db.query<any>(
      'SELECT COUNT(*) AS n FROM nutrition_library_items WHERE gym_id IS NULL AND id IN (SELECT id FROM base_nutrition_library_items)',
    );
    expect(Number(rows[0].n)).toBeGreaterThan(0);
    const { rows: fks } = await db.query<any>(
      `SELECT COUNT(*) AS n FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME = 'nutrition_library_items'
          AND TABLE_NAME IN ('member_nutrition_plan_meal_items','member_nutrition_plan_restrictions','nutrition_plan_template_meal_items')`,
    );
    expect(Number(fks[0].n)).toBe(3);
  });

  it('references the shared lookups and cascades from the Base item', async () => {
    const { rows } = await db.query<any>(
      `SELECT k.TABLE_NAME AS t, k.REFERENCED_TABLE_NAME AS ref, r.DELETE_RULE AS rule
         FROM information_schema.KEY_COLUMN_USAGE k
         JOIN information_schema.REFERENTIAL_CONSTRAINTS r
           ON r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.CONSTRAINT_SCHEMA = k.TABLE_SCHEMA
        WHERE k.TABLE_SCHEMA = DATABASE() AND k.TABLE_NAME LIKE 'base_nutrition_library_item_%'`,
    );
    const refs = new Set(rows.map((r: any) => r.ref));
    expect(refs).toEqual(new Set(['base_nutrition_library_items', 'nutrition_library_categories', 'nutritional_qualities']));
    expect(rows.every((r: any) => r.rule === 'CASCADE')).toBe(true);
  });
});
