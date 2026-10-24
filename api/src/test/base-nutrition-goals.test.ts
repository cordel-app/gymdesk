// #1849 stage N4: migration 323 deletes the legacy System rows of nutrition_goals;
// base_nutrition_goals (copied by 321, ids kept) is the only copy of a System goal.

import { afterAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';

afterAll(async () => {
  await db.end();
});

describe('base_nutrition_goals after the legacy delete (#1849 stage N4)', () => {
  it('holds the seven seeded System goals', async () => {
    const { rows } = await db.query<any>(
      `SELECT slug, name FROM base_nutrition_goals
        WHERE slug IN ('calories','protein','carbohydrates','fats','fiber','water','fasting') ORDER BY slug`,
    );
    expect(rows.map((r: any) => r.slug)).toEqual(
      ['calories', 'carbohydrates', 'fasting', 'fats', 'fiber', 'protein', 'water']);
    expect(rows.find((r: any) => r.slug === 'protein').name).toBe('Protein');
  });

  it('keeps the seeded translations in the Base junction', async () => {
    const { rows } = await db.query<any>(
      `SELECT COUNT(*) AS n FROM base_nutrition_goal_translations t
         JOIN base_nutrition_goals b ON b.id = t.base_nutrition_goal_id AND b.slug = 'protein'`,
    );
    expect(Number(rows[0].n)).toBeGreaterThan(0);
  });

  it('leaves no System row in nutrition_goals', async () => {
    const { rows } = await db.query<any>('SELECT COUNT(*) AS n FROM nutrition_goals WHERE gym_id IS NULL');
    expect(Number(rows[0].n)).toBe(0);
  });
});
