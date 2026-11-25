import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { cascadeResultParts, cascadeSections } from '../app/[locale]/training-plan-templates/cascadeImportPreview';

// #3337 stage 2 — the Import System Training Plan Templates modal confirms the
// cascade the API previews (POST /import/preview) before POST /import runs it.

const DIR = join(__dirname, '..', 'app', '[locale]', 'training-plan-templates');
const modal = readFileSync(join(DIR, 'ImportTrainingPlanTemplatesModal.tsx'), 'utf-8');
const locales = ['en', 'es', 'ca'].map((l) =>
  JSON.parse(readFileSync(join(__dirname, '..', '..', 'locales', 'base', `${l}.json`), 'utf-8')));

describe('cascadeSections', () => {
  const preview = {
    training_plan_templates: [{ id: 1, name: 'Plan', action: 'create' as const, gym_template_id: null }],
    workout_templates: [
      { id: 10, name: 'Push', action: 'create' as const, gym_template_id: null },
      { id: 11, name: 'Pull', action: 'update' as const, gym_template_id: 99 },
    ],
    exercises: [{ id: 5, name: 'Bench Press' }],
  };

  it('labels each Workout Template with the API\'s own operation, in its order', () => {
    expect(cascadeSections(preview).workoutTemplates).toEqual([
      { id: 10, name: 'Push', actionKey: 'cascade_action_create' },
      { id: 11, name: 'Pull', actionKey: 'cascade_action_update' },
    ]);
  });

  it('lists exactly the Exercises the API reports as missing', () => {
    expect(cascadeSections(preview).exercises).toEqual([{ id: 5, name: 'Bench Press' }]);
    expect(cascadeSections({ ...preview, exercises: [] }).exercises).toEqual([]);
  });
});

describe('cascadeResultParts', () => {
  it('reports only the non-zero parts of a cascading import', () => {
    expect(cascadeResultParts({
      imported: [1, 2], skipped: [],
      workout_templates: { created: [3], updated: [] },
      exercises: { imported: [4, 5, 6] },
    })).toEqual([['imported', 2], ['cascade_result_workouts_created', 1], ['cascade_result_exercises_imported', 3]]);
  });

  it('tolerates a response with no cascade fields', () => {
    expect(cascadeResultParts({ imported: [], skipped: [1] })).toEqual([['imported', 0], ['imported_skipped', 1]]);
  });
});

describe('the modal', () => {
  it('previews before importing and imports only from the confirmation step', () => {
    expect(modal).toContain("'/training-plan-templates/import/preview'");
    expect(modal).toContain('onClick={handlePreview}');
    // The import request is reached only from the confirmation's Confirm button.
    expect(modal.match(/onClick=\{handleImport\}/g)).toHaveLength(1);
    expect(modal.indexOf('onClick={handleImport}')).toBeLessThan(modal.indexOf("t('import_modal_title')"));
  });

  it('has every key it resolves in all three languages', () => {
    const keys = [...new Set([...modal.matchAll(/\bt\('([a-z_]+)'/g)].map((m) => m[1]))]
      .concat(['cascade_action_create', 'cascade_action_update', 'cascade_result_workouts_created',
        'cascade_result_workouts_updated', 'cascade_result_exercises_imported', 'imported', 'imported_skipped']);
    for (const messages of locales) {
      for (const key of keys) expect(messages.training_plan_templates[key], key).toBeTruthy();
    }
  });
});
