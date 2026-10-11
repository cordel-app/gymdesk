import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  EMPTY_EXERCISE_FILTER,
  exerciseFacetValueLabel,
  exerciseFilterChips,
  exerciseFilterQuery,
  isExerciseFilterActive,
  type ExerciseFilterState,
} from '@/lib/exerciseFilters';

// #969 — the compact exercise catalogue toolbar, and (stage 2) its three
// consumers.
//
//   one row     → [ Search ] [ Slug ] [ Muscles ▾ ] [ Equipment ▾ ] [ Category ▾ ] [ Status ▾ ] [ Clear ]
//   under it    → `Showing 42 of 612 exercises` and the active-filter chips, on one line
//   everything  → filtered server-side; this module only decides what is asked for
//
// This repo has no component-test infra for apps/admin (docs/architecture.md's
// TL;DR), so — like exercise-read-only-expansion.test.ts (#965) — the structure
// is pinned by scanning the source while the pure state module is exercised
// directly.

const SRC = join(__dirname, '..');

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const read = (path: string) => stripComments(readFileSync(path, 'utf-8'));

const bar = read(join(SRC, 'components', 'exercises', 'ExerciseFilterBar.tsx'));
const basePage = read(join(SRC, 'app', '[locale]', 'cordel', 'exercises', 'page.tsx'));
const gymPage = read(join(SRC, 'app', '[locale]', 'exercises', 'page.tsx'));
const importModal = read(join(SRC, 'app', '[locale]', 'exercises', 'ImportExercisesModal.tsx'));
const en = JSON.parse(readFileSync(join(SRC, '..', 'locales', 'base', 'en.json'), 'utf-8'));
const es = JSON.parse(readFileSync(join(SRC, '..', 'locales', 'base', 'es.json'), 'utf-8'));
const ca = JSON.parse(readFileSync(join(SRC, '..', 'locales', 'base', 'ca.json'), 'utf-8'));

const state = (over: Partial<ExerciseFilterState> = {}): ExerciseFilterState => ({
  ...EMPTY_EXERCISE_FILTER, ...over,
});

describe('the filter state', () => {
  it('starts asking for nothing', () => {
    expect(isExerciseFilterActive(EMPTY_EXERCISE_FILTER)).toBe(false);
    expect(exerciseFilterQuery(EMPTY_EXERCISE_FILTER)).toBe('');
  });

  it('treats whitespace in a text field as nothing typed', () => {
    expect(isExerciseFilterActive(state({ q: '   ' }))).toBe(false);
    expect(exerciseFilterQuery(state({ q: '  ' }))).toBe('');
  });

  it('sends the search term trimmed, and never a language (§3/§18)', () => {
    // The server matches the base name *or* any stored translation, so there is
    // no locale parameter to send — the user must not have to know which
    // language is on screen.
    expect(exerciseFilterQuery(state({ q: '  bench ' }))).toBe('?q=bench');
    expect(exerciseFilterQuery(state({ q: 'bench' }))).not.toContain('locale');
  });

  it('has no slug filter (#1356)', () => {
    expect(Object.keys(EMPTY_EXERCISE_FILTER)).not.toContain('slug');
  });

  it('puts the checked muscles in the parameter the chosen role names (§7)', () => {
    expect(exerciseFilterQuery(state({ muscles: ['chest'] }))).toBe('?muscle=chest');
    expect(exerciseFilterQuery(state({ muscles: ['chest'], muscleRole: 'primary' })))
      .toBe('?primary_muscle=chest');
    expect(exerciseFilterQuery(state({ muscles: ['chest'], muscleRole: 'secondary' })))
      .toBe('?secondary_muscle=chest');
  });

  it('sends muscle_match only when it can change the answer (§6)', () => {
    expect(exerciseFilterQuery(state({ muscles: ['chest'], muscleMatch: 'all' })))
      .not.toContain('muscle_match');
    expect(exerciseFilterQuery(state({ muscles: ['chest', 'triceps'], muscleMatch: 'all' })))
      .toBe('?muscle=chest%2Ctriceps&muscle_match=all');
    expect(exerciseFilterQuery(state({ muscles: ['chest', 'triceps'] })))
      .toBe('?muscle=chest%2Ctriceps&muscle_match=any');
  });

  it('sends equipment and category as the multi-value parameters the API reads', () => {
    expect(exerciseFilterQuery(state({ equipment: ['barbell', 'machine'] })))
      .toBe('?equipment=barbell%2Cmachine');
    expect(exerciseFilterQuery(state({ category: ['strength'] }))).toBe('?category=strength');
  });

  it('combines every group in one request (§11)', () => {
    const query = exerciseFilterQuery(state({
      q: 'bench', status: 'active',
      muscles: ['chest', 'triceps'], muscleMatch: 'all', muscleRole: 'primary',
      equipment: ['barbell'], category: ['strength'],
    }));
    const params = new URLSearchParams(query.slice(1));
    expect(Object.fromEntries(params)).toEqual({
      q: 'bench', status: 'active',
      primary_muscle: 'chest,triceps', muscle_match: 'all',
      equipment: 'barbell', category: 'strength',
    });
  });

  it('has no Exercise Type field: the control is Equipment (Q1)', () => {
    expect(Object.keys(EMPTY_EXERCISE_FILTER)).toContain('equipment');
    expect(Object.keys(EMPTY_EXERCISE_FILTER)).not.toContain('exerciseType');
    expect(exerciseFilterQuery(state({ equipment: ['machine'] }))).not.toContain('exercise_type');
  });
});

describe('the active-filter chips (§12)', () => {
  const labels = {
    search: (v: string) => `Search: ${v}`,
    status: (v: string) => v.toUpperCase(),
    muscle: (k: string) => `M:${k}`,
    equipment: exerciseFacetValueLabel,
    category: exerciseFacetValueLabel,
  };

  it('reads one chip per applied criterion, and none when nothing is applied', () => {
    expect(exerciseFilterChips(EMPTY_EXERCISE_FILTER, labels)).toEqual([]);
    const chips = exerciseFilterChips(state({
      q: 'bench', status: 'active', muscles: ['chest', 'triceps'], equipment: ['barbell'],
    }), labels);
    expect(chips.map((c) => c.label)).toEqual([
      'Search: bench', 'ACTIVE', 'M:chest', 'M:triceps', 'Barbell',
    ]);
  });

  it('removes exactly its own criterion and leaves the rest standing', () => {
    const current = state({ q: 'bench', muscles: ['chest', 'triceps'], category: ['strength'] });
    const chips = exerciseFilterChips(current, labels);
    const triceps = chips.find((c) => c.key === 'muscle:triceps')!;
    expect(triceps.next.muscles).toEqual(['chest']);
    expect(triceps.next.q).toBe('bench');
    expect(triceps.next.category).toEqual(['strength']);
    expect(chips.find((c) => c.key === 'q')!.next.muscles).toEqual(['chest', 'triceps']);
  });

  it('keys each chip uniquely, so a React list has no duplicate key', () => {
    const chips = exerciseFilterChips(state({
      q: 'x', status: 'inactive',
      muscles: ['chest'], equipment: ['chest'], category: ['chest'],
    }), labels);
    expect(new Set(chips.map((c) => c.key)).size).toBe(chips.length);
  });
});

describe('a free-text facet value’s label', () => {
  it('is humanized rather than looked up, because the values are the source’s', () => {
    // #964 preserves `equipment`/`category` verbatim, so a value added upstream
    // tomorrow has no locale key — and next-intl prints a missing key verbatim.
    expect(exerciseFacetValueLabel('barbell')).toBe('Barbell');
    expect(exerciseFacetValueLabel('body only')).toBe('Body Only');
    expect(exerciseFacetValueLabel('e-z_curl-bar')).toBe('E Z Curl Bar');
    expect(exerciseFacetValueLabel('')).toBe('');
  });
});

describe('the toolbar is the app’s own chrome, used by the page', () => {
  it('is built from FilterBar / FilterField / filterControlStyle', () => {
    expect(bar).toContain("from '@/components/FilterBar'");
    expect(bar).toContain('<FilterBar');
    expect(bar).toContain('<FilterField');
    expect(bar).toContain('filterControlStyle');
  });

  it('reuses the existing multi-select popover and the list’s own pill', () => {
    expect(bar).toContain("from '@/components/MultiSelectFilter'");
    expect(bar).toContain("from '@/components/StatusFilter'");
    expect(bar).toContain('listNameBadgeStyle');
  });

  it('declares no colour of its own (#724/#913)', () => {
    // Every hue comes from a chrome module it spreads, or is the `var()`
    // fallback a theme token needs for the frames before `applyTokens()` runs.
    // A bare hex would be a second source of truth for the filter bar's look.
    const bare = bar
      .replace(/var\(--[a-z-]+,\s*#[0-9a-fA-F]{3,8}\)/g, '')
      .match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(bare).toEqual([]);
  });

  it('renders one Muscles, one Equipment and one Category control', () => {
    for (const marker of ['exercise-filter-muscles', 'exercise-filter-equipment', 'exercise-filter-category']) {
      expect(bar.match(new RegExp(marker, 'g'))).toHaveLength(1);
    }
  });

  it('hides a metadata control that has no values to offer (§9)', () => {
    expect(bar).toContain('equipmentOptions.length > 0');
    expect(bar).toContain('categoryOptions.length > 0');
  });

  it('is what the Base Exercises page filters with — no second search box', () => {
    expect(basePage).toContain('<ExerciseFilterBar');
    expect(basePage).toContain('exerciseFilterQuery(filter)');
    expect(basePage).not.toContain('searchInputStyle');
    // §14's count needs the unfiltered total, which the facets read carries.
    expect(basePage).toContain('/facets');
    expect(basePage).toContain('shown={rows.length}');
  });

  it('asks the server for the rows rather than filtering them in the page (§16)', () => {
    expect(basePage).not.toMatch(/rows\s*\.filter\(/);
    expect(bar).not.toMatch(/\.filter\(/);
  });
});

// ─── Stage 2: the other two screens ─────────────────────────────────────────
//
// §19 is the stage's whole point — "do not create three independent
// implementations of the same filtering UX" — so what these assert is that each
// screen *renders the shared toolbar over the shared state* and declares no
// filter control, no query building and no narrowing pass of its own.

describe('a gym’s own Exercises list (§19)', () => {
  it('renders the one toolbar over the one filter state', () => {
    expect(gymPage).toContain("from '@/components/exercises/ExerciseFilterBar'");
    expect(gymPage).toContain('<ExerciseFilterBar');
    expect(gymPage).toContain('exerciseFilterQuery(filter)');
    expect(gymPage).toContain('shown={rows.length}');
  });

  it('kept no search box or Status dropdown of its own', () => {
    expect(gymPage).not.toContain("from '@/components/StatusFilter'");
    expect(gymPage).not.toContain('handleSearchChange');
    expect(gymPage).not.toContain('searchInput');
    expect(gymPage).not.toContain("params.set('q'");
    expect(gymPage).not.toContain("params.set('status'");
  });

  it('offers no Slug field (#1356)', () => {
    const bar = gymPage.slice(gymPage.indexOf('<ExerciseFilterBar'));
    expect(bar.slice(0, bar.indexOf('/>'))).not.toContain('showSlug');
    expect(bar.slice(0, bar.indexOf('/>'))).toContain('showStatus');
  });

  it('offers Equipment and Category like Base Exercises (#1384)', () => {
    const bar = gymPage.slice(gymPage.indexOf('<ExerciseFilterBar'));
    expect(bar.slice(0, bar.indexOf('/>'))).toContain('alwaysShowMetadata');
  });

  it('reads the facets and the unfiltered total for §14’s count', () => {
    expect(gymPage).toContain("'/exercises/facets'");
    expect(gymPage).toContain('total={total}');
  });

  it('narrows nothing in the browser (§16)', () => {
    expect(gymPage).not.toMatch(/rows\s*\.filter\(/);
  });
});

describe('the Import modal (§19)', () => {
  it('renders the one toolbar over the one filter state', () => {
    expect(importModal).toContain("from '@/components/exercises/ExerciseFilterBar'");
    expect(importModal).toContain('<ExerciseFilterBar');
    expect(importModal).toContain('exerciseFilterQuery(current)');
  });

  it('offers no Slug field and no Status one', () => {
    // The slug is internal (#1356); the library is `status = 'active'`
    // by definition, so a Status control there would filter nothing.
    const markup = importModal.slice(importModal.indexOf('<ExerciseFilterBar'));
    const props = markup.slice(0, markup.indexOf('/>'));
    expect(props).not.toContain('showSlug');
    expect(props).not.toContain('showStatus');
  });

  it('reads the library’s own gym-facing facets, not the platform’s', () => {
    // `/platform/exercises/facets` is superadmin-only, and a gym admin
    // importing a Base Exercise is not a platform administrator (#718).
    expect(importModal).toContain("'/exercises/base/facets'");
    expect(importModal).not.toContain('/platform/exercises');
  });

  it('keeps its own two filter controls out of the modal', () => {
    expect(importModal).not.toContain('import_filter_name');
    expect(importModal).not.toContain('import_filter_muscle');
  });
});

describe('the locale keys', () => {
  const KEYS = [
    'filter_search', 'filter_search_placeholder',
    'filter_muscles', 'filter_muscles_search',
    'filter_muscle_match', 'filter_muscle_match_any', 'filter_muscle_match_all',
    'filter_muscle_role', 'filter_muscle_role_any', 'filter_muscle_role_primary',
    'filter_muscle_role_secondary',
    'filter_equipment', 'filter_equipment_search', 'filter_category', 'filter_category_search',
    'filter_status', 'filter_status_all', 'filter_clear',
    'filter_result_count', 'filter_result_total',
    'filter_chip_search', 'filter_chip_remove',
  ];

  it('exist in en, es and ca — a missing one prints verbatim', () => {
    for (const locale of [en, es, ca]) {
      for (const key of KEYS) expect(Object.keys(locale.exercises)).toContain(key);
    }
  });

  it('every key the toolbar resolves is one of them', () => {
    for (const key of bar.match(/t\('([a-z0-9_]+)'/g) ?? []) {
      const name = key.slice(3, -1);
      expect(Object.keys(en.exercises), name).toContain(name);
    }
  });

  it('carries the interpolation values each message needs', () => {
    for (const locale of [en, es, ca]) {
      expect(locale.exercises.filter_result_count).toContain('{shown}');
      expect(locale.exercises.filter_result_count).toContain('{total}');
      expect(locale.exercises.filter_result_total).toContain('{shown}');
      expect(locale.exercises.filter_chip_search).toContain('{value}');
      expect(locale.exercises.filter_chip_remove).toContain('{filter}');
    }
  });
});
