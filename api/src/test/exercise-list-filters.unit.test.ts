/**
 * #969 — the exercise lists' filter vocabulary and the SQL it becomes.
 *
 * Unit, because `domain/exerciseListFilters.ts` is pure: it reads a query object
 * and returns a `WHERE` fragment plus its parameters, with no DB and no HTTP.
 * The filters are exercised end to end against MySQL in
 * `base-exercise-source-filters.test.ts`; what matters here is the shape of
 * what is built — above all that a parameter the request never sent adds no
 * clause, which is what keeps an unfiltered list unfiltered.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MUSCLE_MATCH,
  EXERCISE_METADATA_COLUMNS,
  EXERCISE_MUSCLE_MATCHES,
  exerciseFacetsQuery,
  exerciseFacetsSql,
  exerciseListFilterSql,
  groupExerciseFacets,
  isExerciseListFiltered,
  listParam,
  parseExerciseListFilter,
} from '../domain/exerciseListFilters';

function parse(query: Record<string, unknown>) {
  const parsed = parseExerciseListFilter(query);
  if ('error' in parsed) throw new Error(`unexpected error: ${parsed.error}`);
  return parsed.filter;
}

function build(query: Record<string, unknown>, opts?: { withSlug?: boolean }) {
  return exerciseListFilterSql('e', parse(query), opts);
}

describe('listParam', () => {
  it('accepts a comma-separated value and a repeated one alike', () => {
    expect(listParam('chest,triceps')).toEqual(['chest', 'triceps']);
    expect(listParam(['chest', 'triceps'])).toEqual(['chest', 'triceps']);
    expect(listParam(['chest,triceps', 'quads'])).toEqual(['chest', 'triceps', 'quads']);
  });

  it('lower-cases, trims, de-duplicates and drops the empties', () => {
    expect(listParam(' Chest , chest ,, TRICEPS ')).toEqual(['chest', 'triceps']);
    expect(listParam('')).toBeNull();
    expect(listParam(',, ,')).toBeNull();
    expect(listParam(undefined)).toBeNull();
    expect(listParam(42)).toBeNull();
  });
});

describe('parseExerciseListFilter', () => {
  it('reads nothing out of an empty query, and builds no clause from it', () => {
    const filter = parse({});
    expect(filter).toMatchObject({ q: null, slug: null, status: null, metadata: [], muscles: [] });
    expect(filter.muscleMatch).toBe(DEFAULT_MUSCLE_MATCH);
    expect(isExerciseListFiltered(filter)).toBe(false);
    expect(exerciseListFilterSql('e', filter)).toEqual({ sql: '', params: [] });
  });

  it('treats a blank string as absent rather than as a filter', () => {
    const filter = parse({ q: '   ', slug: '', status: '' });
    expect(filter).toMatchObject({ q: null, slug: null, status: null });
    expect(isExerciseListFiltered(filter)).toBe(false);
  });

  it('refuses an unknown status and an unknown muscle_match', () => {
    expect(parseExerciseListFilter({ status: 'deleted' })).toEqual({
      error: 'status must be one of: active, inactive',
    });
    expect(parseExerciseListFilter({ muscle_match: 'either' })).toEqual({
      error: 'muscle_match must be one of: any, all',
    });
  });

  it('ignores an unknown metadata value instead, since those are free text', () => {
    // #964 preserves `equipment`/`category`/`level`/`mechanic` verbatim from the
    // source, so there is no accepted set to compare against — a value nobody
    // has data for simply matches nothing (§8).
    const filter = parse({ equipment: 'kettlebell-cannon' });
    expect(filter.metadata).toEqual([{ column: 'equipment', values: ['kettlebell-cannon'] }]);
  });

  it('reads every metadata column the module declares', () => {
    const filter = parse(Object.fromEntries(EXERCISE_METADATA_COLUMNS.map((c) => [c, 'x'])));
    expect(filter.metadata.map((m) => m.column)).toEqual([...EXERCISE_METADATA_COLUMNS]);
  });

  it('has no Exercise Type filter at all', () => {
    // Migration 074 dropped `exercises.exercise_type` (#154) and #1009 gates the
    // name, so the ticket's `[ Exercise Type ▾ ]` is the dataset's `equipment`
    // axis — an `exercise_type` parameter must be ignored, not invented.
    const filter = parse({ exercise_type: 'time' });
    expect(isExerciseListFiltered(filter)).toBe(false);
    expect(EXERCISE_METADATA_COLUMNS as readonly string[]).not.toContain('exercise_type');
  });
});

describe('the WHERE fragment', () => {
  it('matches the name, its translations and the slug for one ?q=', () => {
    const { sql, params } = build({ q: 'bench' });
    expect(sql).toContain('exercise_translations');
    expect(sql).toContain('e.slug LIKE ?');
    expect(params).toEqual(['%bench%', '%bench%', '%bench%']);
  });

  it('drops the slug arm where the context has no slugs', () => {
    const { sql, params } = build({ q: 'bench' }, { withSlug: false });
    expect(sql).not.toContain('e.slug');
    expect(params).toEqual(['%bench%', '%bench%']);
  });

  it('searches the slug partially, which is also how an exact one matches', () => {
    expect(build({ slug: 'barbell' })).toEqual({
      sql: ' AND e.slug LIKE ?',
      params: ['%barbell%'],
    });
    expect(build({ slug: 'barbell' }, { withSlug: false }).params).toEqual([]);
  });

  it('compares a metadata column directly, never through LOWER()', () => {
    // The collation is already case- and accent-insensitive; a function on the
    // column would only make an index on it unusable (§17).
    const { sql, params } = build({ equipment: 'Barbell,Machine' });
    expect(sql).toBe(' AND e.equipment IN (?, ?)');
    expect(sql).not.toContain('LOWER');
    expect(params).toEqual(['barbell', 'machine']);
  });

  it('muscle_match=any is one IN — the behaviour #964 already had', () => {
    const { sql, params } = build({ muscle: 'chest,triceps' });
    expect(sql.match(/EXISTS/g)).toHaveLength(1);
    expect(sql).toContain('em.muscle IN (?, ?)');
    expect(sql).not.toContain('em.role');
    expect(params).toEqual(['chest', 'triceps']);
  });

  it('muscle_match=all is one EXISTS per muscle', () => {
    const { sql, params } = build({ muscle: 'chest,triceps', muscle_match: 'all' });
    expect(sql.match(/EXISTS/g)).toHaveLength(2);
    expect(params).toEqual(['chest', 'triceps']);
  });

  it('carries the role for the two role-specific parameters', () => {
    expect(build({ primary_muscle: 'chest' }).params).toEqual(['chest', 'principal']);
    expect(build({ secondary_muscle: 'chest' }).params).toEqual(['chest', 'secondary']);
    expect(build({ primary_muscle: 'chest,triceps', muscle_match: 'all' }).params)
      .toEqual(['chest', 'principal', 'triceps', 'principal']);
  });

  it('combines the groups with AND (§11)', () => {
    const { sql, params } = build({ q: 'bench', status: 'active', equipment: 'barbell', muscle: 'chest' });
    expect(sql.match(/ AND /g)!.length).toBeGreaterThanOrEqual(4);
    expect(params).toEqual(['active', '%bench%', '%bench%', '%bench%', 'barbell', 'chest']);
  });

  it('binds one placeholder per parameter, in order', () => {
    const { sql, params } = build({
      q: 'row', slug: 'dumbbell', status: 'inactive',
      equipment: 'dumbbell,barbell', category: 'strength',
      muscle: 'biceps', secondary_muscle: 'forearms',
    });
    expect((sql.match(/\?/g) ?? []).length).toBe(params.length);
  });
});

describe('facets', () => {
  it('asks one statement for every declared column, within the caller’s scope', () => {
    const sql = exerciseFacetsSql("e.gym_id IS NULL AND e.status != 'deleted'");
    for (const column of EXERCISE_METADATA_COLUMNS) {
      expect(sql).toContain(`SELECT '${column}' AS facet`);
      expect(sql).toContain(`GROUP BY e.${column}`);
    }
    expect(sql.match(/UNION ALL/g)).toHaveLength(EXERCISE_METADATA_COLUMNS.length - 1);
    expect(sql.match(/e\.gym_id IS NULL/g)).toHaveLength(EXERCISE_METADATA_COLUMNS.length);
  });

  it('binds a parameterised scope once per column', () => {
    // The scope is repeated across the union's arms, so a gym-scoped facets
    // read (`e.gym_id = ?`, #969 stage 2) needs its value repeated as many
    // times — which is this module's to know, not a router's.
    const { sql, params } = exerciseFacetsQuery("e.gym_id = ? AND e.status != 'deleted'", ['gym-1']);
    expect(params).toEqual(Array(EXERCISE_METADATA_COLUMNS.length).fill('gym-1'));
    expect((sql.match(/\?/g) ?? []).length).toBe(params.length);
  });

  it('binds nothing for a scope that has no parameters', () => {
    const { sql, params } = exerciseFacetsQuery("e.gym_id IS NULL AND e.status = 'active'");
    expect(params).toEqual([]);
    expect(sql).not.toContain('?');
  });

  it('groups the rows per column, sorted, and reports an absent column as empty', () => {
    const facets = groupExerciseFacets([
      { facet: 'equipment', value: 'machine' },
      { facet: 'equipment', value: 'barbell' },
      { facet: 'category', value: 'strength' },
      { facet: 'nonsense', value: 'ignored' },
    ]);
    expect(facets.equipment).toEqual(['barbell', 'machine']);
    expect(facets.category).toEqual(['strength']);
    // A control with no values is one the page does not render (§9).
    expect(facets.level).toEqual([]);
    expect(facets.mechanic).toEqual([]);
    expect(Object.keys(facets).sort()).toEqual([...EXERCISE_METADATA_COLUMNS].sort());
  });
});

describe('the declared sets', () => {
  it('offers exactly two muscle match modes', () => {
    expect(EXERCISE_MUSCLE_MATCHES).toEqual(['any', 'all']);
    expect(DEFAULT_MUSCLE_MATCH).toBe('any');
  });
});
