import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyRecordedMetrics, derivedResultTypeIds, effectiveCategory, parseRecordedMetricsRequest, syncExerciseResultTypes,
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

  it('parses the requested metrics: absent keeps, ids are deduped and sorted, junk or empty is a 400', () => {
    expect(parseRecordedMetricsRequest({}).ids).toBeUndefined();
    expect(parseRecordedMetricsRequest({ allowed_result_type_ids: [4, 2, 2] })).toEqual({ ids: [2, 4], confirm: false });
    expect(parseRecordedMetricsRequest({ allowed_result_type_ids: [1], confirm_metric_removal: true }).confirm).toBe(true);
    expect(() => parseRecordedMetricsRequest({ allowed_result_type_ids: [] })).toThrow();
    expect(() => parseRecordedMetricsRequest({ allowed_result_type_ids: ['x'] })).toThrow();
    expect(() => parseRecordedMetricsRequest({ allowed_result_type_ids: 3 })).toThrow();
  });

  function metricsTx(current: { id: number; slug: string }[], counts: Record<string, number>) {
    const calls: string[] = [];
    const tx: any = {
      query: vi.fn(async (sql: string, params: any[] = []) => {
        calls.push(sql);
        if (sql.includes('WHERE id IN')) return { rows: params.map((id: number) => ({ id, slug: SLUGS[id - 1] })), rowCount: params.length };
        if (sql.includes('JOIN result_types rt')) return { rows: current, rowCount: current.length };
        if (sql.includes('COUNT(*)')) {
          const slug = sql.includes('s.weight') ? 'weight' : sql.includes('s.reps') ? 'repetitions' : 'duration';
          return { rows: [{ n: counts[slug] ?? 0 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    return { tx, calls };
  }

  it('removing a metric that holds recordings needs confirmation and changes nothing without it', async () => {
    const { tx, calls } = metricsTx([{ id: 1, slug: 'repetitions' }, { id: 2, slug: 'weight' }], { weight: 5 });
    await expect(applyRecordedMetrics(tx, 7, 'g', { ids: [1], confirm: false }))
      .rejects.toMatchObject({ status: 409, code: 'metric_removal_requires_confirmation', metrics: [{ slug: 'weight', count: 5 }] });
    expect(calls.some((c) => /^(DELETE|UPDATE)/.test(c))).toBe(false);
  });

  it('with confirmation it deletes only the removed metric\'s recordings, scoped to the gym, then replaces the rows', async () => {
    const { tx, calls } = metricsTx([{ id: 1, slug: 'repetitions' }, { id: 2, slug: 'weight' }], { weight: 5, repetitions: 9 });
    const r = await applyRecordedMetrics(tx, 7, 'g', { ids: [1], confirm: true });
    expect(r.removed.map((m) => m.slug)).toEqual(['weight']);
    const updates = calls.filter((c) => c.startsWith('UPDATE'));
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain('s.weight = NULL');
    expect(updates[0]).toContain('l.gym_id = ?');
    expect(calls.some((c) => c.startsWith('DELETE FROM exercise_allowed_result_types'))).toBe(true);
  });

  it('removing a metric with no recordings, or a metric with no stored data, needs no confirmation', async () => {
    const { tx } = metricsTx([{ id: 1, slug: 'repetitions' }, { id: 3, slug: 'distance' }], {});
    await expect(applyRecordedMetrics(tx, 7, 'g', { ids: [2], confirm: false })).resolves.toEqual({ removed: [] });
  });

  it('a request that does not mention metrics touches nothing', async () => {
    const { tx, calls } = metricsTx([], {});
    await applyRecordedMetrics(tx, 7, 'g', { ids: undefined, confirm: false });
    expect(calls).toHaveLength(0);
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

  it('the write routes persist the join table only through the helpers', () => {
    for (const f of ['exercises.ts', 'platform-exercises.ts']) {
      const src = readFileSync(join(__dirname, '../api', f), 'utf-8');
      expect(src, f).toContain('syncExerciseResultTypes');
      expect(src, f).not.toContain('replaceAllowedResultTypes');
    }
  });
});
