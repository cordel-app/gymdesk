import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #718 — "Import Defaults" becomes an Import Exercises modal over the platform
// Base Exercises library, and the source labels become System sourced / Custom.
//
// The API half (GET /exercises/base, POST /exercises/import) is covered by
// api/src/test/exercises.test.ts. This repo has no component-test infra for
// apps/admin (see docs/architecture.md's TL;DR), so — like
// exercise-status-toggle.test.ts (#673) — this scans the page and modal source
// plus the locale files.

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const EXERCISES_DIR = join(__dirname, '..', 'app', '[locale]', 'exercises');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

type Messages = Record<string, unknown>;

function exercisesKey(messages: Messages, key: string): string | undefined {
  const ns = messages['exercises'];
  if (ns == null || typeof ns !== 'object') return undefined;
  const value = (ns as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/** The source comments name the ticket and the labels, so the scans run comment-free. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const locales = Object.fromEntries(
  LOCALE_CODES.map((c) => [
    c,
    JSON.parse(readFileSync(join(LOCALES_DIR, `${c}.json`), 'utf-8')) as Messages,
  ]),
) as Record<(typeof LOCALE_CODES)[number], Messages>;

const page = stripComments(readFileSync(join(EXERCISES_DIR, 'page.tsx'), 'utf-8'));
const modal = stripComments(readFileSync(join(EXERCISES_DIR, 'ImportExercisesModal.tsx'), 'utf-8'));

const MODAL_KEYS = [
  'import',
  'import_modal_title',
  'import_filter_name',
  'import_filter_name_placeholder',
  'import_filter_muscle',
  'import_filter_muscle_all',
  'import_select_all_matching',
  'import_clear_all_matching',
  'import_available_count',
  'import_selected_count',
  'import_empty',
  'import_importing',
  'imported_with_skipped',
  'type_system_sourced',
  'type_custom',
];

describe('Exercises: Import Exercises modal (#718)', () => {
  it.each(LOCALE_CODES)('has every import and source-label key in %s.json', (code) => {
    for (const key of MODAL_KEYS) {
      expect(exercisesKey(locales[code], key), `${code}.json is missing exercises.${key}`).toBeTruthy();
    }
  });

  it.each(LOCALE_CODES)('drops the retired Import Defaults key and the old source labels in %s.json', (code) => {
    expect(exercisesKey(locales[code], 'import_defaults')).toBeUndefined();
    expect(exercisesKey(locales[code], 'type_base')).toBeUndefined();
    expect(exercisesKey(locales[code], 'type_gym')).toBeUndefined();
  });

  it('labels the header button Import and opens the modal instead of importing', () => {
    expect(page).toContain("t('import')");
    expect(page).toContain('setImportOpen(true)');
    // §1: nothing on this page seeds a default catalog any more.
    expect(page).not.toContain('import-defaults');
    expect(page).not.toContain('importDefaults');
  });

  it('keeps the Import button behind the TRAINING write gate', () => {
    const button = page.slice(page.indexOf('setImportOpen(true)'));
    const end = button.indexOf('</button>');
    expect(button.slice(0, end)).toContain('disabled={!canWrite}');
    expect(button.slice(0, end)).toContain('title={readOnlyTitle}');
  });

  it('renders the modal with the gym muscle catalog and refreshes the list afterwards', () => {
    expect(page).toContain('<ImportExercisesModal');
    expect(page).toContain('muscleKeys={muscleKeys}');
    expect(page).toContain('onImported={handleImported}');
    const handler = page.slice(page.indexOf('function handleImported'));
    expect(handler.slice(0, handler.indexOf('\n  }'))).toContain('load()');
  });

  it('shows System sourced for library and imported exercises, Custom for the gym\'s own', () => {
    expect(page).toContain('const isSystemSourced = isBase || ex.cloned_from_id != null');
    expect(page).toContain("t('type_system_sourced')");
    expect(page).toContain("t('type_custom')");
    expect(page).not.toContain("t('type_base')");
    expect(page).not.toContain("t('type_gym')");
  });

  it('filters the library server-side by name and muscle', () => {
    expect(modal).toContain("params.set('q', q)");
    expect(modal).toContain("params.set('muscle', muscleKey)");
    expect(modal).toContain('/exercises/base');
  });

  it('keys the selection by base exercise id, outside the fetched list', () => {
    expect(modal).toContain('useState<Set<number>>(new Set())');
    // Only opening the modal clears it — a filter change must not.
    const reset = modal.slice(modal.indexOf('if (!open) return;'));
    expect(reset.slice(0, reset.indexOf('}, [open]'))).toContain('setSelected(new Set())');
    const filterEffect = modal.slice(modal.indexOf('const timer = setTimeout(() => load(name, muscle)'));
    expect(filterEffect.slice(0, filterEffect.indexOf('}, [open, name, muscle, load]'))).not.toContain('setSelected');
  });

  it('restricts Select all matching to the filtered, importable rows', () => {
    expect(modal).toContain('const importable = rows.filter((r) => r.imported_exercise_id == null)');
    const fn = modal.slice(modal.indexOf('function toggleAllMatching'));
    const body = fn.slice(0, fn.indexOf('\n  }'));
    expect(body).toContain('for (const row of importable)');
    expect(body).toContain('allMatchingSelected');
  });

  it('shows already-imported exercises but does not let them be selected again', () => {
    expect(modal).toContain('const alreadyImported = row.imported_exercise_id != null');
    expect(modal).toContain('disabled={alreadyImported || importing}');
    expect(modal).toContain("t('type_system_sourced')");
  });

  it('imports the whole selection in one request', () => {
    const fn = modal.slice(modal.indexOf('async function handleImport'));
    const body = fn.slice(0, fn.indexOf('\n  }'));
    expect(body).toContain("'/exercises/import'");
    expect(body).toContain('baseExerciseIds: Array.from(selected)');
    expect(body).toContain("method: 'POST'");
    // Guard against a double submission, and keep the selection on failure.
    expect(body).toContain('if (importing || selected.size === 0) return');
    expect(body).not.toContain('setSelected');
  });

  it('disables Import until something is selected and while it runs', () => {
    expect(modal).toContain('disabled={importing || selected.size === 0}');
    expect(modal).toContain("importing ? t('import_importing') : t('import')");
  });

  it('shows an empty state when the filters match nothing', () => {
    expect(modal).toContain("t('import_empty')");
    expect(modal).toContain('rows.length === 0');
  });
});
