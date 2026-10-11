import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertRequestedResultTypesMatch, derivedResultTypeIds, effectiveCategory, syncExerciseResultTypes,
} from '../api/exercise-result-types';
import { CATEGORY_RESULT_TYPE_SLUGS, EXERCISE_CATEGORIES } from '../domain/exerciseCategories';

// Catalogue as migration 073 seeds it: id = position + 1.
const SLUGS = ['repetitions', 'weight', 'distance', 'duration', 'pace', 'speed', 'calories', 'rpe', 'rest_time'];

function fakeTx(storedCategory: string | null = null) {
  const calls: { sql: string; params: any[] }[] = [];
  const tx: any = {
    query: vi.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('FROM result_types')) {
        const rows = params.map((s: string) => ({ id: SLUGS.indexOf(s) + 1 })).sort((a: any, b: any) => a.id - b.id);
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('SELECT category FROM exercises')) return { rows: [{ category: storedCategory }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
  };
  return { tx, calls };
}

describe('exercise Recorded Metrics derivation (#1360 stage 2)', () => {
  it.each(EXERCISE_CATEGORIES)('derives the ticket set for %s', async (category) => {
    const { tx, calls } = fakeTx();
    await syncExerciseResultTypes(tx, 7, category);
    const inserted = calls.filter((c) => c.sql.startsWith('INSERT IGNORE INTO exercise_allowed_result_types')).map((c) => c.params[1]);
    const expected = CATEGORY_RESULT_TYPE_SLUGS[category].map((s) => SLUGS.indexOf(s) + 1).sort((a, b) => a - b);
    expect(inserted).toEqual(expected);
    expect(calls.some((c) => c.sql.startsWith('DELETE FROM exercise_allowed_result_types'))).toBe(true);
  });

  it('leaves stored rows alone for a missing or unsupported category', async () => {
    for (const category of [null, '', 'yoga']) {
      const { tx, calls } = fakeTx();
      await syncExerciseResultTypes(tx, 7, category);
      expect(calls).toHaveLength(0);
    }
    expect(await derivedResultTypeIds(fakeTx().tx, 'yoga')).toBeNull();
  });

  it('accepts a request that matches the derived set, in any order, and one that omits it', async () => {
    const { tx } = fakeTx();
    await expect(assertRequestedResultTypesMatch(tx, 'strength', [2, 1])).resolves.toBeUndefined();
    await expect(assertRequestedResultTypesMatch(tx, 'strength', undefined)).resolves.toBeUndefined();
  });

  it('refuses a contradicting selection with a 400', async () => {
    const { tx } = fakeTx();
    await expect(assertRequestedResultTypesMatch(tx, 'strength', [1, 2, 3])).rejects.toMatchObject({ status: 400 });
    await expect(assertRequestedResultTypesMatch(tx, 'stretching', [1])).rejects.toMatchObject({ status: 400 });
  });

  it('refuses a manual selection when there is no supported category', async () => {
    const { tx } = fakeTx();
    await expect(assertRequestedResultTypesMatch(tx, null, [1])).rejects.toMatchObject({ status: 400 });
    await expect(assertRequestedResultTypesMatch(tx, 'yoga', [1])).rejects.toMatchObject({ status: 400 });
  });

  it('uses the stored category when the request does not mention one', async () => {
    const { tx } = fakeTx('Cardio ');
    expect(await effectiveCategory(tx, 1, { provided: false, value: null })).toBe('cardio');
    expect(await effectiveCategory(tx, 1, { provided: true, value: 'strength' })).toBe('strength');
    expect(await effectiveCategory(tx, 1, { provided: true, value: null })).toBeNull();
  });

  it('the admin mirror agrees with the API mapping', () => {
    const src = readFileSync(join(__dirname, '../../../apps/admin/src/lib/exerciseCategories.ts'), 'utf-8');
    for (const [category, slugs] of Object.entries(CATEGORY_RESULT_TYPE_SLUGS)) {
      const key = category.includes(' ') ? `'${category}'` : category;
      expect(src, category).toContain(`${key}: [${slugs.map((s) => `'${s}'`).join(', ')}]`);
    }
  });

  it('the write routes persist the join table only through the helper', () => {
    for (const f of ['exercises.ts', 'platform-exercises.ts']) {
      const src = readFileSync(join(__dirname, '../api', f), 'utf-8');
      expect(src, f).toContain('syncExerciseResultTypes');
      expect(src, f).not.toContain('replaceAllowedResultTypes');
    }
  });
});
