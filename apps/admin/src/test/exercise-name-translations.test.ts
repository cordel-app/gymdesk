import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  emptyExerciseForm,
  exerciseFormFromRow,
  toExerciseCreatePayload,
  toExerciseUpdatePayload,
  trimmedTranslations,
} from '@/components/exercises/exerciseForm';
import { NAMED_LOCALES, localeLabel } from '@/lib/localeLabels';
import { exerciseMatchesQuery, exerciseName } from '@/lib/exerciseNames';

// #967 — an exercise name in all three supported languages, on the admin side.
//
// The data model and the resolution are the API's; what this file pins down is
// the half that lives here: the form carries one Name per language, the payloads
// submit them, every surface renders the *resolved* name, and no component
// declares the application's language list — the ticket's closing "Important".
//
// This repo has no component-test infra for apps/admin (docs/architecture.md's
// TL;DR), so the structural rules are asserted by scanning the sources, exactly
// as exercise-editor-unification.test.ts (#806) does.

const SRC = join(__dirname, '..');
const EDITOR = join(SRC, 'components', 'exercises', 'ExerciseEditor.tsx');
const GYM_PAGE = join(SRC, 'app', '[locale]', 'exercises', 'page.tsx');
const BASE_PAGE = join(SRC, 'app', '[locale]', 'cordel', 'exercises', 'page.tsx');
// #965 moved the read-only half of the card into one shared component, and
// `⋮ → Details` with it — which is where the per-language Name rows live: the
// read-only view *is* the editor with its controls replaced by values, so the
// editor's one input per language has one row per language beside it, and the
// Details modal stays the technical metadata alone (#965 §12).
const READ_ONLY_VIEW = join(SRC, 'components', 'exercises', 'ExerciseReadOnlyView.tsx');
const DETAIL_MODAL = join(SRC, 'components', 'exercises', 'ExerciseDetailModal.tsx');
const IMPORT_MODAL = join(SRC, 'app', '[locale]', 'exercises', 'ImportExercisesModal.tsx');
const NUTRITION_PAGE = join(SRC, 'app', '[locale]', 'cordel', 'nutrition-library', 'page.tsx');
const LOCALES_DIR = join(SRC, '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

const read = (path: string) => stripComments(readFileSync(path, 'utf-8'));
const editor = read(EDITOR);
const gymPage = read(GYM_PAGE);
const basePage = read(BASE_PAGE);
const readOnlyView = read(READ_ONLY_VIEW);
const detailModal = read(DETAIL_MODAL);
const importModal = read(IMPORT_MODAL);
const nutritionPage = read(NUTRITION_PAGE);

const messages = Object.fromEntries(
  LOCALE_CODES.map((code) => [code, JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'))]),
);

describe('the form carries one Name per language', () => {
  it('starts empty and seeds from the row the editor was opened with', () => {
    expect(emptyExerciseForm().translations).toEqual({});
    const seeded = exerciseFormFromRow({
      name: 'Bench Press',
      translations: { es: 'Press de Banca' },
      description: null, video_url: null,
      min_reps_default: null, max_reps_default: null, sets_default: null,
      rest_default_seconds: null, notes_default: null, status: 'active',
    });
    expect(seeded.name).toBe('Bench Press');
    expect(seeded.translations).toEqual({ es: 'Press de Banca' });
  });

  it('seeds an empty map from a row that carries none, never undefined', () => {
    const seeded = exerciseFormFromRow({
      name: 'Plank', description: null, video_url: null,
      min_reps_default: null, max_reps_default: null, sets_default: null,
      rest_default_seconds: null, notes_default: null, status: 'active',
    });
    expect(seeded.translations).toEqual({});
  });

  it('submits only the languages that were typed, trimmed', () => {
    expect(trimmedTranslations({ es: '  Press de Banca ', ca: '', en: '   ' }))
      .toEqual({ es: 'Press de Banca' });
  });

  it('includes them in both payloads, beside the base name', () => {
    const form = { ...emptyExerciseForm(), name: ' Bench Press ', translations: { es: ' Press de Banca ' } };
    const extras = { muscles: new Map(), resultTypeIds: new Set<number>() };
    for (const payload of [toExerciseCreatePayload(form, extras), toExerciseUpdatePayload(form, extras)]) {
      expect(payload.name).toBe('Bench Press');
      expect(payload.translations).toEqual({ es: 'Press de Banca' });
    }
  });
});

describe('the editor renders the language inputs without declaring the languages', () => {
  it('takes the locales as a prop and renders one input per translatable locale', () => {
    expect(editor).toContain('nameLocales');
    expect(editor).toContain('translatableLocales.map(');
    expect(editor).toContain('form.translations[loc]');
  });

  it('declares no language list of its own', () => {
    // The configuration is the API's (`SUPPORTED_LOCALES`), so the editor must
    // not name a locale at all.
    for (const tag of ['en', 'es', 'ca', 'fr']) {
      expect(editor).not.toMatch(new RegExp(`['"\`]${tag}['"\`]`));
    }
    expect(editor).not.toContain('English');
  });

  it('keeps the base name required and the translations optional (§5)', () => {
    expect(editor).toContain("t('label_name')} — ${localeName(nameLocales.base)} *");
    expect(editor).toContain('name_translations_hint');
  });
});

describe('both pages read the languages from their own API', () => {
  it('the gym page reads GET /exercises/locales', () => {
    expect(gymPage).toContain("'/exercises/locales'");
    expect(gymPage).toContain('nameLocales={nameLocales}');
  });

  it('the Base Exercises page takes them from the lookups it already reads', () => {
    expect(basePage).toContain('base_locale');
    expect(basePage).toContain('translatable');
    expect(basePage).toContain('nameLocales={nameLocales}');
    // One read, not a second round trip: #806's lookups endpoint carries them.
    expect(basePage).not.toContain('/platform/exercises/locales');
  });

  it('neither page hardcodes a language list', () => {
    for (const page of [gymPage, basePage]) {
      expect(page).not.toContain('English');
      expect(page).not.toContain("['en', 'es', 'ca']");
    }
  });
});

describe('every surface renders the resolved name', () => {
  it('the two lists, the dependency dialog, the Details title and the Import modal', () => {
    expect(gymPage).toContain('ex.display_name ?? ex.name');
    // The Details modal is shared since #965, so the resolved name is read there
    // rather than passed in by each page.
    expect(detailModal).toContain('exerciseName(exercise)');
    expect(gymPage).toContain('depDialog.entity.display_name ?? depDialog.entity.name');
    expect(basePage).toContain('row.display_name ?? row.name');
    expect(importModal).toContain('row.display_name ?? row.name');
  });

  it('the expanded card lists every stored translation — the editor read-only (§6)', () => {
    expect(readOnlyView).toContain('exercise.translations');
    expect(readOnlyView).toContain('localeLabel(');
  });

  it('Details stays the technical metadata alone (#965 §12)', () => {
    expect(detailModal).not.toContain('translations');
    expect(detailModal).not.toContain('localeLabel(');
  });

  it('exerciseName() prefers the resolved field and never renders undefined', () => {
    expect(exerciseName({ name: 'Bench Press', display_name: 'Press de Banca' })).toBe('Press de Banca');
    expect(exerciseName({ name: 'Bench Press' })).toBe('Bench Press');
    expect(exerciseName({ name: 'Bench Press', display_name: null })).toBe('Bench Press');
  });
});

describe('a picker searches every translation (§7)', () => {
  const row = {
    name: 'Bench Press',
    display_name: 'Bench Press',
    translations: { es: 'Press de Banca', ca: 'Press de banca' },
  };

  it('matches the base name, the displayed name and any translation', () => {
    expect(exerciseMatchesQuery(row, 'bench')).toBe(true);
    expect(exerciseMatchesQuery(row, 'press de ban')).toBe(true);
    expect(exerciseMatchesQuery(row, ' BANCA ')).toBe(true);
    expect(exerciseMatchesQuery(row, 'squat')).toBe(false);
  });

  it('matches everything on an empty query, and tolerates a row with no translations', () => {
    expect(exerciseMatchesQuery(row, '   ')).toBe(true);
    expect(exerciseMatchesQuery({ name: 'Plank' }, 'plank')).toBe(true);
    expect(exerciseMatchesQuery({ name: 'Plank' }, 'plancha')).toBe(false);
  });

  it('is what the comboboxes filter with, rather than a second copy', () => {
    for (const path of [
      join(SRC, 'app', '[locale]', 'workout-templates', 'WorkoutTemplateTree.tsx'),
      join(SRC, 'app', '[locale]', 'workout-templates', 'WorkoutBlockBuilder.tsx'),
      join(SRC, 'app', '[locale]', 'members', 'PlanBlockExercisesModal.tsx'),
    ]) {
      const src = read(path);
      expect(src).toContain("from '@/lib/exerciseNames'");
      expect(src).not.toContain('o.name.toLowerCase().includes');
    }
  });
});

describe('the language names live in one module', () => {
  it('every named locale has a label in all three locale files', () => {
    for (const code of LOCALE_CODES) {
      for (const tag of NAMED_LOCALES) {
        expect(messages[code].languages?.[tag], `languages.${tag} missing from ${code}.json`).toBeTruthy();
      }
    }
  });

  it('falls back to the tag before calling t(), never printing the key', () => {
    const translate = (key: string) => `MISSING:${key}`;
    expect(localeLabel('fr', translate)).toBe('FR');
    expect(localeLabel('es', translate)).toBe('MISSING:languages.es');
  });

  it('the Nutrition Library\'s translation inputs use the same module (#643 + #967)', () => {
    expect(nutritionPage).toContain("from '@/lib/localeLabels'");
    expect(nutritionPage).not.toContain('LOCALE_LABELS');
  });

  it('the hint is present in all three locale files', () => {
    for (const code of LOCALE_CODES) {
      expect(messages[code].exercises?.name_translations_hint).toBeTruthy();
    }
  });
});
