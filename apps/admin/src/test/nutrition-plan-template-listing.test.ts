import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  NUM_DAYS_OPTIONS, canResyncWithSystem, isValidNumDays, templateFormFromRow,
  templatePayload, templateSource, toNumDays,
} from '../app/[locale]/nutrition/nutrition-plan-templates/nutritionPlanTemplateList';

// #3333 stage 2 — both Nutrition Plan Template lists wear the Exercises listing:
// Import System Nutrition Plan Templates, Resync, the shared Source chip, a Days
// column (num_days 0..7) and the Cards/List toggle.

const APP = join(__dirname, '..', 'app', '[locale]');
const gymPage = readFileSync(join(APP, 'nutrition', 'nutrition-plan-templates', 'page.tsx'), 'utf-8');
const basePage = readFileSync(join(APP, 'cordel', 'nutrition-plan-templates', 'page.tsx'), 'utf-8');
const modal = readFileSync(join(APP, 'nutrition', 'nutrition-plan-templates', 'ImportNutritionPlanTemplatesModal.tsx'), 'utf-8');
const exercisesPage = readFileSync(join(APP, 'exercises', 'page.tsx'), 'utf-8');

describe('num_days', () => {
  it('offers exactly the integers 0..7', () => {
    expect(NUM_DAYS_OPTIONS).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('accepts only an integer in range', () => {
    for (const ok of [0, 3, 7]) expect(isValidNumDays(ok)).toBe(true);
    for (const bad of [-1, 8, 3.5, '3', null, undefined, NaN]) expect(isValidNumDays(bad)).toBe(false);
  });

  it('reads a stored value (mysql2 may answer a string) and falls back to 0', () => {
    expect(toNumDays(5)).toBe(5);
    expect(toNumDays('6')).toBe(6);
    expect(toNumDays(null)).toBe(0);
    expect(toNumDays(9)).toBe(0);
  });
});

describe('templatePayload', () => {
  it('trims, nulls an empty description and sends num_days', () => {
    const r = templatePayload({ name: '  Keto ', description: ' ', status: 'active', num_days: 5 });
    expect(r).toEqual({ ok: true, body: { name: 'Keto', description: null, status: 'active', num_days: 5 } });
  });

  it('refuses a blank name and an out-of-range day count', () => {
    expect(templatePayload({ name: ' ', description: '', status: 'active', num_days: 1 })).toEqual({ ok: false, errorKey: 'error_required' });
    expect(templatePayload({ name: 'X', description: '', status: 'active', num_days: 8 })).toEqual({ ok: false, errorKey: 'error_num_days' });
  });

  it('seeds the edit form from a row', () => {
    expect(templateFormFromRow({ name: 'A', description: null, status: 'draft', num_days: '4' }))
      .toEqual({ name: 'A', description: '', status: 'draft', num_days: 4 });
  });
});

describe('Source and Resync', () => {
  it('reads the API-derived source; a Base row is the System row itself', () => {
    expect(templateSource({ gym_id: 'g', source: 'system' })).toBe('system');
    expect(templateSource({ gym_id: 'g', source: 'custom' })).toBe('custom');
    expect(templateSource({ gym_id: null })).toBe('system');
  });

  it('offers Resync only on a gym copy of a System template', () => {
    expect(canResyncWithSystem({ gym_id: 'g', source: 'system' })).toBe(true);
    expect(canResyncWithSystem({ gym_id: 'g', source: 'custom' })).toBe(false);
    expect(canResyncWithSystem({ gym_id: null, source: 'system' })).toBe(false);
  });
});

describe('the pages', () => {
  it('the gym list imports, resyncs and toggles views', () => {
    expect(gymPage).toContain("t('nutrition_plan_templates.import_system_templates')");
    expect(gymPage).toContain('<ImportNutritionPlanTemplatesModal');
    expect(gymPage).toContain('/resync-with-system');
    expect(gymPage).toContain('<ExerciseViewToggle');
    expect(gymPage).toContain('<NutritionPlanTemplateCard');
  });

  it('both lists show Days in place of Primary Muscles, and a Source column', () => {
    for (const src of [gymPage, basePage]) {
      expect(src).toContain("labelKey: 'col_days'");
      expect(src).toContain("labelKey: 'col_source'");
      expect(src).not.toContain('primary_muscles');
      expect(src).toContain('<ExerciseViewToggle');
    }
  });

  it('the import modal reads the gym-facing catalogue and posts the API body', () => {
    expect(modal).toContain('/nutrition-plan-templates/base');
    expect(modal).toContain('/nutrition-plan-templates/import');
    expect(modal).toContain('baseTemplateIds');
  });

  it('Exercises and Nutrition Plan Templates draw the one Source chip', () => {
    expect(exercisesPage).toContain('<SourceChip');
    expect(gymPage).toContain('<SourceChip');
  });
});
