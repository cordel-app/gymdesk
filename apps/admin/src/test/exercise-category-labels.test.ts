import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXERCISE_CATEGORIES, exerciseCategoryLabel, exerciseCategoryLabelKey } from '../lib/exerciseCategories';

const LOCALES = ['en', 'es', 'ca'] as const;
const load = (l: string) => JSON.parse(readFileSync(join(__dirname, `../../locales/base/${l}.json`), 'utf8')).exercises;

describe('#1355 exercise category labels', () => {
  it('every supported category has a label in en, es and ca', () => {
    for (const l of LOCALES) {
      const ex = load(l);
      for (const c of EXERCISE_CATEGORIES) {
        expect(ex[exerciseCategoryLabelKey(c) as string], `${l}:${c}`).toBeTruthy();
      }
    }
  });

  it('resolves a supported id through the locale, the stored value otherwise', () => {
    const es = load('es');
    const label = (v: string) => exerciseCategoryLabel(v, (k) => es[k], (x) => `~${x}`);
    expect(label('strength')).toBe('Fuerza');
    expect(label('Olympic Weightlifting')).toBe('Halterofilia olímpica');
    expect(label('odd value')).toBe('~odd value');
    expect(exerciseCategoryLabel('', () => 'x', () => 'y')).toBe('');
  });

  it('the filter bar and the read-only card use the one helper', () => {
    for (const f of ['components/exercises/ExerciseFilterBar.tsx', 'components/exercises/ExerciseReadOnlyView.tsx']) {
      expect(readFileSync(join(__dirname, '..', f), 'utf8')).toContain('exerciseCategoryLabel');
    }
  });
});
