import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  DEFAULT_EXERCISE_VIEW_MODE,
  EXERCISE_VIEW_MODE_STORAGE_KEY,
  parseExerciseViewMode,
  readExerciseViewMode,
  writeExerciseViewMode,
} from '../lib/exerciseViewMode';

// #1386 — Cards/List toggle on both Exercise pages.
const SRC = join(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(SRC, ...p), 'utf8');

describe('exercise view mode (#1386)', () => {
  it('defaults to cards and ignores unknown values', () => {
    expect(DEFAULT_EXERCISE_VIEW_MODE).toBe('cards');
    expect(parseExerciseViewMode(null)).toBe('cards');
    expect(parseExerciseViewMode('grid')).toBe('cards');
    expect(parseExerciseViewMode('list')).toBe('list');
  });

  it('round-trips through storage and survives it throwing or being absent', () => {
    const data: Record<string, string> = {};
    const storage = { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v; } };
    writeExerciseViewMode(storage, 'list');
    expect(data[EXERCISE_VIEW_MODE_STORAGE_KEY]).toBe('list');
    expect(readExerciseViewMode(storage)).toBe('list');
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(readExerciseViewMode(broken)).toBe('cards');
    expect(() => writeExerciseViewMode(broken, 'list')).not.toThrow();
    expect(readExerciseViewMode(null)).toBe('cards');
  });

  it('both pages render the toggle on the filter row and the same card', () => {
    for (const page of [read('app/[locale]/exercises/page.tsx'), read('app/[locale]/cordel/exercises/page.tsx')]) {
      expect(page).toContain('<ExerciseViewToggle');
      expect(page).toContain('<ExerciseCard');
      expect(page).toContain('useExerciseViewMode');
    }
  });

  it('the card filters nothing and spells no colour literal of its own', () => {
    const card = read('components/exercises/ExerciseCard.tsx');
    expect(card).not.toMatch(/\.filter\(\(\w+\) => \w+\.(status|name)/);
    // A hex inside `var(--token, #fallback)` is the theme variable's own fallback, not a literal.
    expect(card.replace(/var\([^)]*\)/g, '')).not.toMatch(/#[0-9a-fA-F]{6}\b/);
  });
});
