// #1849 stage 2a: migration 304 copies the System Personal Goals into
// base_personal_goals, keeping ids, and leaves the legacy rows untouched.

import { afterAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';

afterAll(async () => {
  await db.end();
});

describe('base_personal_goals copy (#1849 stage 2a)', () => {
  it('holds every System goal under its original id with the same definition', async () => {
    // Only the seeded (slugged) System goals: other test files may add System
    // goals after the migration ran, and those were never copied. The id list
    // stays in SQL because `db.query` is a prepared statement and does not
    // expand an array bound to `IN (?)`.
    const { rows: legacy } = await db.query<any>(
      `SELECT id, slug, name, target_value, target_unit, target_type FROM personal_goals
        WHERE gym_id IS NULL AND slug IS NOT NULL ORDER BY id`,
    );
    expect(legacy.length).toBeGreaterThan(0);
    const { rows: base } = await db.query<any>(
      `SELECT id, slug, name, target_value, target_unit, target_type FROM base_personal_goals
        WHERE id IN (SELECT id FROM personal_goals WHERE gym_id IS NULL AND slug IS NOT NULL)
        ORDER BY id`,
    );
    expect(base).toEqual(legacy);
  });

  it('copies the translations of the System goals', async () => {
    const { rows } = await db.query<any>(
      `SELECT COUNT(*) AS missing FROM personal_goal_translations t
         JOIN personal_goals g ON g.id = t.personal_goal_id AND g.gym_id IS NULL AND g.slug IS NOT NULL
         LEFT JOIN base_personal_goal_translations b
           ON b.base_personal_goal_id = t.personal_goal_id AND b.locale = t.locale
        WHERE b.locale IS NULL`,
    );
    expect(Number(rows[0].missing)).toBe(0);
  });

  it('leaves the legacy System rows in place', async () => {
    const { rows } = await db.query<any>(
      'SELECT COUNT(*) AS n FROM personal_goals WHERE gym_id IS NULL AND slug IS NOT NULL',
    );
    expect(Number(rows[0].n)).toBeGreaterThanOrEqual(7);
  });
});
