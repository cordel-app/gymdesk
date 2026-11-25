import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  cascadeExercises, cascadeResultParts, needsCascadeConfirmation,
} from '../app/[locale]/workout-templates/cascadeImportPreview';

// #3339 — the Import System Workout Templates modal confirms the Exercises the
// API previews (POST /workout-templates/import/preview) before POST /import runs.

const DIR = join(__dirname, '..', 'app', '[locale]', 'workout-templates');
const modal = readFileSync(join(DIR, 'ImportWorkoutTemplatesModal.tsx'), 'utf-8');
const locales = ['en', 'es', 'ca'].map((l) =>
  JSON.parse(readFileSync(join(__dirname, '..', '..', 'locales', 'base', `${l}.json`), 'utf-8')));

const preview = {
  workout_templates: [
    { id: 10, name: 'Push', action: 'create' as const, gym_template_id: null },
    { id: 11, name: 'Pull', action: 'existing' as const, gym_template_id: 99 },
  ],
  exercises: [{ id: 5, name: 'Bench Press' }, { id: 6, name: 'Row' }],
};

describe('the confirmation step', () => {
  it('is shown only when Exercises would be imported', () => {
    expect(needsCascadeConfirmation(preview)).toBe(true);
    expect(needsCascadeConfirmation({ ...preview, exercises: [] })).toBe(false);
  });

  it('lists the API\'s Exercises in its own order', () => {
    expect(cascadeExercises(preview)).toEqual([{ id: 5, name: 'Bench Press' }, { id: 6, name: 'Row' }]);
  });

  it('previews before importing and imports from the confirmation', () => {
    expect(modal).toContain("'/workout-templates/import/preview'");
    expect(modal).toMatch(/onClick=\{handlePreview\}/);
    expect(modal).toMatch(/onClick=\{handleImport\}/);
  });
});

describe('cascadeResultParts', () => {
  it('adds the imported Exercises only when there are any', () => {
    expect(cascadeResultParts({ imported: [1, 2], skipped: [], exercises: { imported: [7] } }))
      .toEqual([['imported', 2], ['cascade_result_exercises_imported', 1]]);
    expect(cascadeResultParts({ imported: [1], skipped: [3], exercises: { imported: [] } }))
      .toEqual([['imported', 1], ['imported_skipped', 1]]);
  });

  it('every key it answers exists in the three locales', () => {
    for (const l of locales) {
      for (const key of ['imported', 'imported_skipped', 'cascade_result_exercises_imported', 'cascade_title',
        'cascade_description', 'cascade_exercises_heading', 'cascade_analysing']) {
        expect(l.workout_templates[key], key).toBeTruthy();
      }
    }
  });
});
