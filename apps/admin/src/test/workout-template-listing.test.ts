import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { canResyncWithSystem, templateSource, toNumBlocks } from '../app/[locale]/workout-templates/workoutTemplateList';

// #3335 stage 2 — both Workout Template lists wear the Exercises listing:
// Import System Workout Templates, Resync, the shared Source chip, a Blocks
// column (`num_blocks`, derived by the API) and the Cards/List toggle.

const APP = join(__dirname, '..', 'app', '[locale]');
const gymPage = readFileSync(join(APP, 'workout-templates', 'page.tsx'), 'utf-8');
const basePage = readFileSync(join(APP, 'cordel', 'workout-templates', 'page.tsx'), 'utf-8');
const rowCells = readFileSync(join(APP, 'workout-templates', 'WorkoutTemplateRowCells.tsx'), 'utf-8');
const card = readFileSync(join(APP, 'workout-templates', 'WorkoutTemplateCard.tsx'), 'utf-8');
const modal = readFileSync(join(APP, 'workout-templates', 'ImportWorkoutTemplatesModal.tsx'), 'utf-8');
const locales = Object.fromEntries(['en', 'es', 'ca'].map((l) => [
  l, JSON.parse(readFileSync(join(__dirname, '..', '..', 'locales', 'base', `${l}.json`), 'utf-8')).workout_templates,
]));

describe('toNumBlocks', () => {
  it('reads num_blocks, then blocks_count, as mysql2 may answer them', () => {
    expect(toNumBlocks({ num_blocks: 4 })).toBe(4);
    expect(toNumBlocks({ num_blocks: '3' })).toBe(3);
    expect(toNumBlocks({ blocks_count: '2' })).toBe(2);
    expect(toNumBlocks({ num_blocks: 0, blocks_count: 5 })).toBe(0);
  });

  it('reads anything unusable as 0', () => {
    expect(toNumBlocks({})).toBe(0);
    expect(toNumBlocks({ num_blocks: -1 })).toBe(0);
    expect(toNumBlocks({ num_blocks: null, blocks_count: 'x' })).toBe(0);
  });
});

describe('Source and Resync', () => {
  it('reads a Base row as System, a gym copy by the API\'s derived source', () => {
    expect(templateSource({ gym_id: null })).toBe('system');
    expect(templateSource({ gym_id: 'g1', source: 'system' })).toBe('system');
    expect(templateSource({ gym_id: 'g1', source: 'custom' })).toBe('custom');
    expect(templateSource({ gym_id: 'g1' })).toBe('custom');
  });

  it('offers Resync only on a gym\'s copy of a System template', () => {
    expect(canResyncWithSystem({ gym_id: 'g1', source: 'system' })).toBe(true);
    expect(canResyncWithSystem({ gym_id: 'g1', source: 'custom' })).toBe(false);
    expect(canResyncWithSystem({ gym_id: null })).toBe(false);
  });
});

describe('the two lists', () => {
  it('declare a Blocks column and no Primary Muscles, Days, Type or Workout Info column', () => {
    expect(rowCells).toContain("key: 'blocks', labelKey: 'col_blocks'");
    expect(rowCells).toContain("key: 'source', labelKey: 'col_source'");
    for (const gone of ['primary_muscles', "'days'", "key: 'type'", 'workout_info']) {
      expect(rowCells).not.toContain(gone);
    }
  });

  it('share the row cells, the card and the Cards/List toggle', () => {
    for (const src of [gymPage, basePage]) {
      expect(src).toContain('<WorkoutTemplateRowCells');
      expect(src).toContain('<WorkoutTemplateCard');
      expect(src).toContain('<ExerciseViewToggle');
    }
    expect(rowCells).toContain('<SourceChip');
    expect(card).toContain('<SourceChip');
  });

  it('gives the gym list Import and Resync, and no Clone of a Base row', () => {
    expect(gymPage).toContain("t('import_system_templates')");
    expect(gymPage).toContain('<ImportWorkoutTemplatesModal');
    expect(gymPage).toContain('/resync-with-system');
    expect(gymPage).toContain('canResyncWithSystem(wt)');
    expect(gymPage).not.toContain('/clone');
    expect(modal).toContain('/workout-templates/base');
    expect(modal).toContain("'/workout-templates/import'");
    expect(modal).toContain('imported_template_id');
  });

  it('speaks through locale keys on the Base page', () => {
    expect(basePage).not.toMatch(/>Base Workout Templates</);
    expect(basePage).toContain("t('base_title')");
  });

  it('has every key it uses in all three languages', () => {
    const used = new Set<string>();
    for (const src of [gymPage, basePage, rowCells, card, modal]) {
      for (const m of src.matchAll(/\bt\('([a-z_]+)'/g)) used.add(m[1]);
      for (const m of src.matchAll(/labelKey: '([a-z_]+)'/g)) used.add(m[1]);
    }
    for (const [lang, ns] of Object.entries(locales)) {
      for (const key of used) expect(ns, `${lang} lacks workout_templates.${key}`).toHaveProperty(key);
    }
  });
});
