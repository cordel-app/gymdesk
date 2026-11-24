import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  NUM_DAYS_OPTIONS, canResyncWithSystem, isValidNumDays, templateFormFromRow,
  templatePayload, templateSource, toNumDays,
} from '../app/[locale]/training-plan-templates/trainingPlanTemplateList';

// #3334 stage 2 — both Training Plan Template lists wear the Exercises listing:
// Import System Training Plan Templates, Resync, the shared Source chip, a Days
// column (num_days 0..7) and the Cards/List toggle.

const APP = join(__dirname, '..', 'app', '[locale]');
const gymPage = readFileSync(join(APP, 'training-plan-templates', 'page.tsx'), 'utf-8');
const basePage = readFileSync(join(APP, 'cordel', 'training-plan-templates', 'page.tsx'), 'utf-8');
const rowCells = readFileSync(join(APP, 'training-plan-templates', 'TemplateRowCells.tsx'), 'utf-8');
const modal = readFileSync(join(APP, 'training-plan-templates', 'ImportTrainingPlanTemplatesModal.tsx'), 'utf-8');

describe('num_days', () => {
  it('offers exactly the integers 0..7 and accepts nothing else', () => {
    expect(NUM_DAYS_OPTIONS).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    for (const ok of [0, 3, 7]) expect(isValidNumDays(ok)).toBe(true);
    for (const bad of [-1, 8, 3.5, '3', null, undefined, NaN]) expect(isValidNumDays(bad)).toBe(false);
  });

  it('reads a stored value (mysql2 may answer a string) and falls back to 0', () => {
    expect(toNumDays('6')).toBe(6);
    expect(toNumDays(null)).toBe(0);
    expect(toNumDays(9)).toBe(0);
  });
});

describe('templatePayload', () => {
  it('trims, nulls an empty description and sends num_days', () => {
    expect(templatePayload({ name: '  Strength ', description: ' ', status: 'active', num_days: 4 }))
      .toEqual({ ok: true, body: { name: 'Strength', description: null, status: 'active', num_days: 4 } });
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

describe('the lists', () => {
  it('declare Days and Source columns in place of Primary Muscles and the old Type', () => {
    const declaration = rowCells.match(/export const LIST_COLUMNS: ListColumn\[\] = \[[\s\S]*?\n\];/)?.[0] ?? '';
    const keys = [...declaration.matchAll(/\bkey: '([a-z_]+)'/g)].map((m) => m[1]);
    expect(keys).toEqual(['name', 'description', 'days', 'created_at', 'created_by', 'source', 'status', 'expand', 'actions']);
    for (const src of [gymPage, basePage]) {
      expect(src).toContain('<TemplateRowCells');
      expect(src).toContain('<ExerciseViewToggle');
    }
  });

  it('one row component draws the Source chip for both lists', () => {
    expect(rowCells).toContain('<SourceChip');
  });

  it('the gym list imports and resyncs, and no longer clones a Base row', () => {
    expect(gymPage).toContain("t('import_system_templates')");
    expect(gymPage).toContain('<ImportTrainingPlanTemplatesModal');
    expect(gymPage).toContain('/resync-with-system');
    expect(gymPage).not.toContain('/clone');
  });

  it('the import modal reads the gym-facing catalogue and posts the API body', () => {
    expect(modal).toContain('/training-plan-templates/base');
    expect(modal).toContain('/training-plan-templates/import');
    expect(modal).toContain('baseTemplateIds');
  });
});
