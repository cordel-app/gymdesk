// #1849 stages E1/E6 (Exercises): migration 336 creates base_exercises and its four junctions and
// copies the System rows (ids kept); migration 343 deletes the legacy System rows.

import { afterAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';

afterAll(async () => {
  await db.end();
});

describe('base_exercises (#1849 stage E1)', () => {
  it('has no legacy System exercise left (migration 343)', async () => {
    const { rows } = await db.query<any>('SELECT COUNT(*) AS n FROM exercises WHERE gym_id IS NULL');
    expect(Number(rows[0].n)).toBe(0);
  });

  it('keeps ids disjoint: no Base exercise shares an id with a gym-owned one, and the sequence is past every Base id', async () => {
    const { rows } = await db.query<any>(
      'SELECT COUNT(*) AS n FROM base_exercises b JOIN exercises e ON e.id = b.id AND e.gym_id IS NOT NULL',
    );
    expect(Number(rows[0].n)).toBe(0);
    // information_schema caches table statistics; refresh the one AUTO_INCREMENT read below.
    await db.query('ANALYZE TABLE exercises');
    const { rows: seq } = await db.query<any>(
      `SELECT TABLE_NAME AS t, AUTO_INCREMENT AS a FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('base_exercises', 'exercises')`,
    );
    const a = Object.fromEntries(seq.map((r: any) => [r.t, Number(r.a)]));
    const { rows: max } = await db.query<any>('SELECT COALESCE(MAX(id), 0) AS m FROM base_exercises');
    expect(a.exercises).toBeGreaterThan(Number(max[0].m));
  });

  it('cascades the junctions from the Base exercise and keeps the shared lookups', async () => {
    const { rows } = await db.query<any>(
      `SELECT k.TABLE_NAME AS t, k.REFERENCED_TABLE_NAME AS ref, r.DELETE_RULE AS rule
         FROM information_schema.KEY_COLUMN_USAGE k
         JOIN information_schema.REFERENTIAL_CONSTRAINTS r
           ON r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.CONSTRAINT_SCHEMA = k.TABLE_SCHEMA
        WHERE k.TABLE_SCHEMA = DATABASE() AND k.TABLE_NAME LIKE 'base\\_exercise\\_%'`,
    );
    const refs = new Set(rows.map((r: any) => r.ref));
    expect(refs).toEqual(new Set(['base_exercises', 'muscles', 'result_types']));
    for (const r of rows.filter((x: any) => x.ref === 'base_exercises')) expect(r.rule, r.t).toBe('CASCADE');
  });

  it('keeps the FK of the plan tables to the legacy table for gym-owned exercises', async () => {
    const { rows } = await db.query<any>(
      `SELECT COUNT(*) AS n FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME = 'exercises'
          AND TABLE_NAME IN ('workout_template_exercises','workout_exercises','exercise_logs','member_standalone_exercises')`,
    );
    expect(Number(rows[0].n)).toBe(4);
  });
});
