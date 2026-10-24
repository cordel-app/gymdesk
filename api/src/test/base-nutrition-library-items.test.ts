// #1849 stages F1 + F5 (Foods): the System Foods live in the base_nutrition_library_* tables
// (copied under their original ids by migration 324); since migration 333 the legacy
// System rows are gone, and nothing references one.

import { afterAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { FOOD_REFERENCE_TABLES } from '../domain/baseFoodLinkAudit';

afterAll(async () => {
  await db.end();
});

describe('base_nutrition_library_items (#1849 stages F1, F5)', () => {
  it('has no legacy System row left in nutrition_library_items, nor in its junctions', async () => {
    const { rows } = await db.query<any>('SELECT COUNT(*) AS n FROM nutrition_library_items WHERE gym_id IS NULL AND name NOT LIKE \'Test%\' AND name NOT LIKE \'NL Test%\'');
    expect(Number(rows[0].n)).toBe(0);
    for (const t of ['nutrition_library_item_categories', 'nutrition_library_item_qualities', 'nutrition_library_item_translations', 'nutrition_library_item_description_translations']) {
      const { rows: orphans } = await db.query<any>(
        `SELECT COUNT(*) AS n FROM ${t} j JOIN nutrition_library_items i ON i.id = j.item_id AND i.gym_id IS NULL
          WHERE i.name NOT LIKE 'Test%' AND i.name NOT LIKE 'NL Test%'`,
      );
      expect(Number(orphans[0].n), t).toBe(0);
    }
  });

  it('keeps the plan tables\' foreign keys on both food tables (the old one for gym-owned foods)', async () => {
    const { rows: fks } = await db.query<any>(
      `SELECT REFERENCED_TABLE_NAME AS ref, COUNT(*) AS n FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IN ('nutrition_library_items', 'base_nutrition_library_items')
          AND TABLE_NAME IN (${FOOD_REFERENCE_TABLES.map((t) => `'${t}'`).join(',')})
        GROUP BY REFERENCED_TABLE_NAME`,
    );
    expect(Object.fromEntries(fks.map((r: any) => [r.ref, Number(r.n)]))).toEqual({ nutrition_library_items: 6, base_nutrition_library_items: 6 });
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
