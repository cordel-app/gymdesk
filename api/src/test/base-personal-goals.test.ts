// #1849 stage 2f-2: migration 320 deletes the legacy System rows of personal_goals;
// base_personal_goals (copied by 304, ids kept) is the only copy of a System goal.

import { afterAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';

afterAll(async () => {
  await db.end();
});

describe('base_personal_goals after the legacy delete (#1849 stage 2f-2)', () => {
  it('holds the seven seeded System goals with their definition', async () => {
    const { rows } = await db.query<any>(
      `SELECT slug, name, target_value, target_unit, target_type FROM base_personal_goals
        WHERE slug IN ('weight_loss','weight_gain','muscle_gain','maintenance','performance','recovery','energy')
        ORDER BY slug`,
    );
    expect(rows.map((r: any) => r.slug)).toEqual(
      ['energy', 'maintenance', 'muscle_gain', 'performance', 'recovery', 'weight_gain', 'weight_loss']);
    const loss = rows.find((r: any) => r.slug === 'weight_loss');
    expect(loss.name).toBe('Weight Loss');
    expect(Number(loss.target_value)).toBe(-3);
    expect(loss.target_unit).toBe('kg');
    expect(loss.target_type).toBe('relative');
  });

  it('keeps the seeded translations in the Base junction', async () => {
    const { rows } = await db.query<any>(
      `SELECT COUNT(*) AS n FROM base_personal_goal_translations t
         JOIN base_personal_goals b ON b.id = t.base_personal_goal_id AND b.slug = 'weight_loss'`,
    );
    expect(Number(rows[0].n)).toBeGreaterThan(0);
  });

  it('leaves no System row in personal_goals', async () => {
    const { rows } = await db.query<any>('SELECT COUNT(*) AS n FROM personal_goals WHERE gym_id IS NULL');
    expect(Number(rows[0].n)).toBe(0);
  });
});
