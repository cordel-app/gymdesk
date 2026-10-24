// #1849 stage N1: migration 321 copies the System Nutrition Goals into
// base_nutrition_goals, keeping ids, and leaves the legacy rows untouched.

import { afterAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';

afterAll(async () => {
  await db.end();
});

describe('base_nutrition_goals copy (#1849 stage N1)', () => {
  it('holds every seeded System goal under its original id with the same definition', async () => {
    // Only the seeded (slugged) rows: other test files add System goals after the migration ran.
    const { rows: legacy } = await db.query<any>(
      `SELECT id, slug, name, description FROM nutrition_goals
        WHERE gym_id IS NULL AND slug IS NOT NULL ORDER BY id`,
    );
    expect(legacy.length).toBeGreaterThanOrEqual(7);
    const { rows: base } = await db.query<any>(
      `SELECT id, slug, name, description FROM base_nutrition_goals
        WHERE id IN (SELECT id FROM nutrition_goals WHERE gym_id IS NULL AND slug IS NOT NULL) ORDER BY id`,
    );
    expect(base).toEqual(legacy);
  });

  it('copies the translations of the seeded System goals', async () => {
    const { rows } = await db.query<any>(
      `SELECT COUNT(*) AS missing FROM nutrition_goal_translations t
         JOIN nutrition_goals g ON g.id = t.nutrition_goal_id AND g.gym_id IS NULL AND g.slug IS NOT NULL
         LEFT JOIN base_nutrition_goal_translations b
           ON b.base_nutrition_goal_id = t.nutrition_goal_id AND b.locale = t.locale
        WHERE b.locale IS NULL`,
    );
    expect(Number(rows[0].missing)).toBe(0);
  });

  it('leaves the legacy System rows in place', async () => {
    const { rows } = await db.query<any>(
      'SELECT COUNT(*) AS n FROM nutrition_goals WHERE gym_id IS NULL AND slug IS NOT NULL',
    );
    expect(Number(rows[0].n)).toBeGreaterThanOrEqual(7);
  });
});
