import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  BLOCK_TYPES, BLOCK_TYPE_CONFIG,
  blockConfigInput, blockConfigPatch, getBlockConfig,
} from '../app/[locale]/workout-templates/blockFieldConfig';

// #672 — a Workout Block's block-level configuration follows its Block Type:
//
//   Standard / Superset / Triset / Giant Set → none
//   Circuit                                  → Rounds
//   EMOM / AMRAP                             → Minutes
//   Tabata                                   → Intervals
//
// The map and its conversions are pure, so they are unit-tested directly. The
// three editors that render the field (Workouts, Workout Templates, and the
// member Training Plan blocks modal) have no component-test infra in this repo
// (see docs/architecture.md's TL;DR), so — like sellable-items-price-label.test.ts
// (#670) — they are covered by scanning their source and the locale files.

const APP_DIR = join(__dirname, '..', 'app', '[locale]');
const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

const EDITORS = {
  workouts: join(APP_DIR, 'workout-templates', 'WorkoutBlockBuilder.tsx'),
  templates: join(APP_DIR, 'workout-templates', 'WorkoutTemplateTree.tsx'),
  planBlocks: join(APP_DIR, 'members', 'PlanWorkoutBlocksModal.tsx'),
} as const;

// The source comments name #672 and the fields it retires, so the scans below
// run against comment-free code.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const sources = Object.fromEntries(
  Object.entries(EDITORS).map(([key, path]) => [key, stripComments(readFileSync(path, 'utf-8'))]),
) as Record<keyof typeof EDITORS, string>;

const locales = Object.fromEntries(
  LOCALE_CODES.map((c) => [
    c,
    JSON.parse(readFileSync(join(LOCALES_DIR, `${c}.json`), 'utf-8')) as Record<string, any>,
  ]),
) as Record<(typeof LOCALE_CODES)[number], Record<string, any>>;

function message(code: (typeof LOCALE_CODES)[number], key: string): string | undefined {
  const [namespace, name] = key.split('.');
  const ns = locales[code][namespace];
  if (ns == null || typeof ns !== 'object') return undefined;
  const value = ns[name];
  return typeof value === 'string' ? value : undefined;
}

describe('block configuration by type (#672)', () => {
  it('gives the four multi-exercise set types no block-level configuration', () => {
    for (const type of ['Standard', 'Superset', 'Triset', 'GiantSet']) {
      expect(getBlockConfig(type), `${type} still exposes a configuration field`).toBeNull();
    }
  });

  it('gives Circuit Rounds, EMOM/AMRAP Minutes and Tabata Intervals', () => {
    expect(getBlockConfig('Circuit')).toMatchObject({
      column: 'rounds', storedPerUnit: 1, labelKey: 'workout_template_blocks.col_rounds',
    });
    for (const type of ['EMOM', 'AMRAP']) {
      expect(getBlockConfig(type), type).toMatchObject({
        column: 'duration_seconds', storedPerUnit: 60, labelKey: 'workout_template_blocks.col_minutes',
      });
    }
    expect(getBlockConfig('Tabata')).toMatchObject({
      column: 'rounds', storedPerUnit: 1, labelKey: 'workout_template_blocks.col_intervals',
    });
  });

  it('covers every block type exactly once and offers at most one field each', () => {
    expect(Object.keys(BLOCK_TYPE_CONFIG).sort()).toEqual([...BLOCK_TYPES].sort());
    for (const type of BLOCK_TYPES) {
      const cfg = BLOCK_TYPE_CONFIG[type];
      if (cfg) expect(['rounds', 'duration_seconds']).toContain(cfg.column);
    }
  });

  it('never offers work_seconds or rest_seconds — no type configures them any more', () => {
    const columns: string[] = BLOCK_TYPES
      .map((type) => BLOCK_TYPE_CONFIG[type]?.column)
      .filter((c): c is NonNullable<typeof c> => c != null);
    expect(columns).not.toContain('work_seconds');
    expect(columns).not.toContain('rest_seconds');
  });

  it('reads Minutes out of the seconds column and writes them back as seconds', () => {
    const emom = getBlockConfig('EMOM')!;
    expect(blockConfigInput({ type: 'EMOM', rounds: null, duration_seconds: 600 })).toBe('10');
    expect(blockConfigPatch(emom, '10')).toEqual({ duration_seconds: 600 });
    // Round-trips: what is typed is what comes back.
    expect(blockConfigInput({ type: 'EMOM', rounds: null, duration_seconds: 60 * 7 })).toBe('7');
  });

  it('reads Rounds and Intervals straight out of the rounds column', () => {
    expect(blockConfigInput({ type: 'Circuit', rounds: 5, duration_seconds: null })).toBe('5');
    expect(blockConfigPatch(getBlockConfig('Circuit')!, '5')).toEqual({ rounds: 5 });
    expect(blockConfigInput({ type: 'Tabata', rounds: 8, duration_seconds: null })).toBe('8');
    expect(blockConfigPatch(getBlockConfig('Tabata')!, '8')).toEqual({ rounds: 8 });
  });

  it('shows nothing for a type without configuration, whatever the row holds', () => {
    // A Standard block written before #672 may still carry rounds; it is no
    // longer displayed or editable.
    expect(blockConfigInput({ type: 'Standard', rounds: 3, duration_seconds: null })).toBe('');
    expect(blockConfigInput({ type: 'GiantSet', rounds: 4, duration_seconds: 120 })).toBe('');
  });

  it('treats an emptied input as null rather than 0 or NaN', () => {
    expect(blockConfigInput({ type: 'Circuit', rounds: null, duration_seconds: null })).toBe('');
    expect(blockConfigPatch(getBlockConfig('Circuit')!, '')).toEqual({ rounds: null });
    expect(blockConfigPatch(getBlockConfig('EMOM')!, '  ')).toEqual({ duration_seconds: null });
    expect(blockConfigPatch(getBlockConfig('EMOM')!, 'abc')).toEqual({ duration_seconds: null });
  });

  it('writes only the current type\'s column, leaving the other one to the caller', () => {
    // The editors submit the whole block body, so a column this type does not
    // show keeps its stored value instead of being cleared.
    expect(Object.keys(blockConfigPatch(getBlockConfig('EMOM')!, '12'))).toEqual(['duration_seconds']);
    expect(Object.keys(blockConfigPatch(getBlockConfig('Tabata')!, '8'))).toEqual(['rounds']);
  });
});

describe('block configuration editors (#672)', () => {
  it.each(Object.keys(EDITORS) as (keyof typeof EDITORS)[])(
    '%s renders the one field the type config names, not a hardcoded Rounds input',
    (editor) => {
      const src = sources[editor];
      expect(src).toContain('getBlockConfig(');
      expect(src, 'still branches on the retired per-field visibility helper')
        .not.toMatch(/isBlockFieldVisible/);
      expect(src, 'still hardcodes the Rounds label').not.toMatch(/summary_rounds'|col_rounds'/);
    },
  );

  it('routes every configuration write through blockConfigPatch', () => {
    for (const editor of Object.keys(EDITORS) as (keyof typeof EDITORS)[]) {
      expect(sources[editor], editor).toContain('blockConfigPatch(');
      // No editor may write the rounds column directly any more.
      expect(sources[editor], editor).not.toMatch(/rounds:\s*rounds\s*\?/);
    }
  });

  it('stops offering Work and Rest seconds on the member Training Plan blocks modal', () => {
    expect(sources.planBlocks).not.toMatch(/col_work_seconds|col_rest_seconds|col_duration'/);
  });

  it('keeps Sets an exercise-level field', () => {
    // The ticket is explicit: Sets does not move to the block level.
    expect(sources.workouts).toContain("t('block_exercises.col_sets')");
    for (const editor of ['workouts', 'templates'] as const) {
      expect(sources[editor], editor).not.toMatch(/patchBlock\(\{\s*sets/);
    }
  });
});

describe('block configuration labels (#672)', () => {
  const EXPECTED: Record<string, Record<(typeof LOCALE_CODES)[number], string>> = {
    'workout_template_blocks.col_rounds': { en: 'Rounds', es: 'Rondas', ca: 'Rondes' },
    'workout_template_blocks.col_minutes': { en: 'Minutes', es: 'Minutos', ca: 'Minuts' },
    'workout_template_blocks.col_intervals': { en: 'Intervals', es: 'Intervalos', ca: 'Intervals' },
    'training_plan_templates.summary_intervals': {
      en: '{n} intervals', es: '{n} intervalos', ca: '{n} intervals',
    },
  };

  it.each(LOCALE_CODES)('defines every label a block type can ask for in %s.json', (code) => {
    for (const [key, byLocale] of Object.entries(EXPECTED)) {
      expect(message(code, key), `${code}.json is missing ${key}`).toBe(byLocale[code]);
    }
    // Every key the config map points at must resolve.
    for (const type of BLOCK_TYPES) {
      const cfg = BLOCK_TYPE_CONFIG[type];
      if (!cfg) continue;
      expect(message(code, cfg.labelKey), `${code}.json is missing ${cfg.labelKey}`).toBeDefined();
      expect(message(code, cfg.summaryKey), `${code}.json is missing ${cfg.summaryKey}`).toBeDefined();
    }
  });

  it('drops the labels of the retired block fields', () => {
    for (const code of LOCALE_CODES) {
      for (const key of [
        'workout_template_blocks.col_duration',
        'workout_template_blocks.col_work_seconds',
        'workout_template_blocks.col_rest_seconds',
        'training_plan_templates.summary_work',
        'training_plan_templates.summary_rest',
      ]) {
        expect(message(code, key), `${code}.json still defines ${key}`).toBeUndefined();
      }
    }
  });

  it('leaves the exercise-level Rest label alone', () => {
    // Rest stays on the exercise row; only the block-level Work/Rest went away.
    expect(message('en', 'block_exercises.col_rest_min')).toBeDefined();
    expect(message('en', 'training_plan_templates.summary_rest_ex')).toBeDefined();
  });
});
