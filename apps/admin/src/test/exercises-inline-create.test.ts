import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  EXERCISE_CONFIGURATION_FIELDS,
  EXERCISE_FORM_SECTIONS,
  EXERCISE_GENERAL_FIELDS,
  EXERCISE_STATUSES,
  RESULT_TYPE_SLUGS,
  emptyExerciseForm,
  exerciseFormFromRow,
  isExerciseFormValid,
  resultTypeLabel,
  toExerciseCreatePayload,
  toExerciseUpdatePayload,
  type MuscleRole,
} from '@/components/exercises/exerciseForm';

// #805 — "+ Add Exercise" opens an inline creation card instead of a modal,
// both halves of the page render one declared section order, Media is last
// with Image and Video side by side, and Allowed Result Types shows translated
// labels rather than `exercises.result_type_*` keys.
//
// apps/admin has no component-test infra (docs/architecture.md TL;DR), so the
// structural half is pinned by scanning the page source the way
// centers-inline-edit.test.ts does; the section declaration, the label helper
// and the payload mappings are pure and exercised directly.

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const EXERCISES_DIR = join(__dirname, '..', 'app', '[locale]', 'exercises');
// #806 moved the form body out of the page and into the shared editor both
// Exercise screens render, so the structural assertions below read it there.
const EDITOR = join(__dirname, '..', 'components', 'exercises', 'ExerciseEditor.tsx');
// #965 moved the field chrome one file over again, so the Edit view and the
// read-only expanded view are laid out by the same values — and the read-only
// counterpart of the editor is where the expanded card's sections now live.
const CHROME = join(__dirname, '..', 'components', 'exercises', 'exerciseFieldChrome.ts');
const READ_ONLY = join(__dirname, '..', 'components', 'exercises', 'ExerciseReadOnlyView.tsx');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const pageSrc = stripComments(readFileSync(join(EXERCISES_DIR, 'page.tsx'), 'utf-8'));
const chromeSrc = stripComments(readFileSync(CHROME, 'utf-8'));
const readOnlySrc = stripComments(readFileSync(READ_ONLY, 'utf-8'));
const editorSrc = stripComments(readFileSync(EDITOR, 'utf-8'));
const hookSrc = stripComments(readFileSync(
  join(__dirname, '..', 'components', 'exercises', 'useExerciseEditorState.ts'), 'utf-8'));

function exercisesNamespace(code: string): Record<string, string> {
  const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
  return (messages.exercises ?? {}) as Record<string, string>;
}

const locales = Object.fromEntries(LOCALE_CODES.map((c) => [c, exercisesNamespace(c)]));

/** The source between two markers. */
function slice(from: string, to: string, src: string = pageSrc): string {
  const start = src.indexOf(from);
  const end = src.indexOf(to, start + from.length);
  expect(start, `marker not found: ${from}`).toBeGreaterThan(-1);
  expect(end, `marker not found after ${from}: ${to}`).toBeGreaterThan(start);
  return src.slice(start, end);
}

/** The one form body every Exercise editing surface renders (#806). */
const formSrc = slice('export function ExerciseEditor(', 'export function ExerciseMediaPair(', editorSrc);
/** The inline creation card. */
const newRowSrc = slice('function renderInlineNewRow(', 'function renderEditSection(');

const noExtras = { muscles: new Map<string, MuscleRole>(), resultTypeIds: new Set<number>() };

describe('Exercises: inline creation (#805)', () => {
  describe('AC1 — no modal', () => {
    it('the page no longer builds a CrudModal', () => {
      expect(pageSrc).not.toContain('CrudModal');
      expect(pageSrc).not.toContain('FormLabel');
      expect(pageSrc).not.toContain('FormInput');
    });

    it('the modal title key is gone from every locale', () => {
      for (const code of LOCALE_CODES) expect(locales[code].modal_add).toBeUndefined();
      expect(pageSrc).not.toContain("t('modal_add')");
    });

    it('"+ Add Exercise" opens the inline card', () => {
      expect(pageSrc).toContain('onClick={openAdd}');
      expect(pageSrc).toContain('function renderInlineNewRow()');
      expect(pageSrc).toContain('{renderInlineNewRow()}');
    });

    it('the creation card and the editor render the same form body', () => {
      expect(newRowSrc).toContain('<ExerciseEditor');
      expect(slice('function renderEditSection(', 'function renderViewSection(')).toContain('<ExerciseEditor');
    });
  });

  describe('AC2 — General is first, with Name, Description, Status in that order', () => {
    it('the declaration puts general first', () => {
      expect(EXERCISE_FORM_SECTIONS[0].key).toBe('general');
      expect([...EXERCISE_GENERAL_FIELDS]).toEqual(['name', 'description', 'status']);
    });

    it('the form body renders them in that order', () => {
      const positions = ["t('label_name')", "t('label_description')", "t('label_status')"]
        .map((label) => formSrc.indexOf(label));
      expect(positions.every((p) => p > -1)).toBe(true);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    });

    it('Status sits in General, before the Configuration heading', () => {
      expect(formSrc.indexOf("t('label_status')")).toBeLessThan(formSrc.indexOf("t('section_configuration')"));
    });
  });

  describe('AC3 — every existing field remains available', () => {
    it('the configuration defaults are all still rendered', () => {
      for (const field of EXERCISE_CONFIGURATION_FIELDS) {
        expect(formSrc, field).toContain(`t('label_${field}')`);
      }
    });

    it('neither mode offers a Video URL input (#1380)', () => {
      expect(newRowSrc).toContain('mode="create"');
      expect(slice('function renderEditSection(', 'function renderViewSection(')).toContain('mode="edit"');
      expect(editorSrc).not.toContain('video_url');
      expect(editorSrc).not.toContain('showVideoUrl');
    });

    it('both statuses are still offered', () => {
      expect([...EXERCISE_STATUSES]).toEqual(['active', 'inactive']);
    });
  });

  describe('AC4 — Allowed Result Types use translated labels', () => {
    it('every seeded slug has a label in every locale', () => {
      for (const code of LOCALE_CODES) {
        for (const slug of RESULT_TYPE_SLUGS) {
          expect(locales[code][`result_type_${slug}`], `${code}.result_type_${slug}`).toBeTruthy();
        }
      }
    });

    it('no locale label is the raw key', () => {
      for (const code of LOCALE_CODES) {
        for (const slug of RESULT_TYPE_SLUGS) {
          expect(locales[code][`result_type_${slug}`]).not.toContain('result_type_');
        }
      }
    });

    it('resolves a seeded slug through the translator', () => {
      const label = resultTypeLabel({ id: 1, name: 'Repetitions', slug: 'repetitions' }, (k) => `translated:${k}`);
      expect(label).toBe('translated:result_type_repetitions');
    });

    it('falls back to the catalogue name for a slug added after the locale files', () => {
      const translate = (k: string) => `exercises.${k}`;
      expect(resultTypeLabel({ id: 99, name: 'Heart Rate', slug: 'heart_rate' }, translate)).toBe('Heart Rate');
    });

    it('both halves of the card go through the helper', () => {
      // #1360 stage 2: both halves render the one RecordedMetrics component.
      const recordedSrc = stripComments(readFileSync(new URL('../components/exercises/RecordedMetrics.tsx', import.meta.url), 'utf-8'));
      expect(recordedSrc).toContain('resultTypeLabel(rt,');
      expect(editorSrc).toContain('<RecordedMetrics');
      expect(readOnlySrc).toContain('<RecordedMetrics');
      expect(recordedSrc).not.toContain('.map((rt) => rt.name)');
    });
  });

  describe('AC5 — Recorded Metrics are read-only chips (#1360)', () => {
    it('renders no checkbox for result types', () => {
      expect(editorSrc).not.toContain('resultTypeIds');
    });
  });

  describe('AC7/AC8 — Media is last, Image and Video side by side', () => {
    it('Media is the final section of the declaration', () => {
      expect(EXERCISE_FORM_SECTIONS[EXERCISE_FORM_SECTIONS.length - 1].key).toBe('media');
    });

    it('the declared order is General, Configuration, Result Types, Muscles, Media', () => {
      expect(EXERCISE_FORM_SECTIONS.map((s) => s.key)).toEqual([
        'general', 'configuration', 'result_types', 'muscles', 'media',
      ]);
    });

    it('no section heading is rendered after Media', () => {
      const mediaAt = formSrc.indexOf("t('section_media')");
      expect(mediaAt).toBeGreaterThan(-1);
      for (const heading of ["t('section_general')", "t('section_configuration')", "t('label_result_types')", "t('section_muscles')"]) {
        expect(formSrc.indexOf(heading), heading).toBeLessThan(mediaAt);
      }
    });

    it('the media pair is one responsive grid, Image before Video', () => {
      expect(chromeSrc).toMatch(/exerciseMediaGridStyle[\s\S]*?repeat\(auto-fit, minmax\(260px, 1fr\)\)/);
      expect(editorSrc).toContain('const mediaGridSt = exerciseMediaGridStyle;');
      const pairSrc = slice('export function ExerciseMediaPair(', 'const inlineLabelSt', editorSrc);
      expect(pairSrc).toContain('style={mediaGridSt}');
      expect(pairSrc.indexOf("t('label_image')")).toBeLessThan(pairSrc.indexOf("t('label_video')"));
    });
  });

  describe('AC9 — the media upload behaviour is untouched', () => {
    it('the creation card still stages both files for after the exercise exists', () => {
      expect(newRowSrc).toContain('onStaged={setStagedImage}');
      expect(newRowSrc).toContain('onStaged={setStagedVideo}');
      expect(pageSrc).toContain('`/exercises/${created.id}/image`');
      expect(pageSrc).toContain('`/exercises/${created.id}/video`');
    });

    it('the editor still acts on the exercise directly', () => {
      const editSrc = slice('function renderEditSection(', 'function renderViewSection(');
      expect(editSrc).toContain('exerciseId={ex.id}');
      expect(editSrc).toContain('onChanged={(updated) => applyExerciseUpdate(updated as Exercise)}');
    });
  });

  describe('AC10/AC11/AC12 — Save, Cancel and validation', () => {
    it('the form renders its own error line, Save/Cancel pair and saving state', () => {
      expect(formSrc).toContain('{state.error &&');
      expect(formSrc).toContain("t('cancel')");
      expect(formSrc).toContain('disabled={state.saving}');
      expect(formSrc).toContain("{state.saving ? t('saving') : primaryLabel}");
    });

    it('Cancel calls no API and discards the staged state', () => {
      const cancel = slice('function closeAdd()', 'async function handleAdd()');
      expect(cancel).not.toContain('apiFetch');
      expect(cancel).toContain('setAddOpen(false)');
      expect(cancel).toContain('addState.reset(null)');
      expect(cancel).toContain('setStagedImage(null)');
      expect(cancel).toContain('setStagedVideo(null)');
    });

    it('Save posts to the existing creation endpoint', () => {
      expect(pageSrc).toContain("apiFetch<Exercise>('/exercises', {");
      expect(pageSrc).toContain('toExerciseCreatePayload(addState.form, addState.extras)');
    });

    it('keeps the card open with the input intact when the API rejects it', () => {
      // #806: `submit()` reports the failure rather than throwing, and the card
      // is closed only once it has said the save landed.
      const handleAdd = slice('async function handleAdd()', 'function handleImported(');
      expect(handleAdd).toContain('const saved = await addState.submit(');
      expect(handleAdd).toMatch(/if \(!saved\) return;\s*\n\s*closeAdd\(\);/);
      expect(hookSrc).toMatch(/} catch \(err: any\) \{\s*\n\s*setError\(err\?\.message \?\? t\('error_generic'\)\);\s*\n\s*return false;/);
    });

    it('requires a name, in both halves', () => {
      // One validation, in the shared hook both halves submit through.
      expect(hookSrc).toContain("if (!isExerciseFormValid(form)) { setError(t('error_required')); return false; }");
      expect(pageSrc).toContain('addState.submit(');
      expect(pageSrc).toContain('editState.submit(');
      expect(isExerciseFormValid(emptyExerciseForm())).toBe(false);
      expect(isExerciseFormValid({ ...emptyExerciseForm(), name: '   ' })).toBe(false);
      expect(isExerciseFormValid({ ...emptyExerciseForm(), name: 'Squat' })).toBe(true);
    });

    it('labels the inline form and its actions in every locale', () => {
      for (const code of LOCALE_CODES) {
        expect(locales[code].new_exercise, `${code}.new_exercise`).toBeTruthy();
        expect(locales[code].save, `${code}.save`).toBeTruthy();
      }
    });
  });

  describe('the payload', () => {
    const form = {
      ...emptyExerciseForm(),
      name: '  Back Squat  ',
      description: ' heavy ',
      video_url: ' https://example.com/v.mp4 ',
      min_reps_default: '5',
      max_reps_default: '8',
      sets_default: '4',
      rest_default_seconds: '90',
      notes_default: ' brace ',
      status: 'inactive',
    };
    const extras = {
      muscles: new Map<string, MuscleRole>([['quads', 'principal'], ['glutes', 'secondary']]),
      resultTypeIds: new Set([1, 2]),
    };

    it('trims, nulls empties and parses the numbers', () => {
      expect(toExerciseCreatePayload(form, extras)).toEqual({
        name: 'Back Squat',
        description: 'heavy',
        min_reps_default: 5,
        max_reps_default: 8,
        sets_default: 4,
        rest_default_seconds: 90,
        notes_default: 'brace',
        status: 'inactive',
        muscles: [{ key: 'quads', role: 'principal' }, { key: 'glutes', role: 'secondary' }],
        // #967: the per-language names ride along with the base one; this form
        // has none typed, so the set is empty (never absent — omitting the field
        // means "leave the stored translations alone").
        translations: {},
      });
    });

    it('an empty optional field becomes null, not an empty string or NaN', () => {
      const payload = toExerciseCreatePayload({ ...emptyExerciseForm(), name: 'Row' }, noExtras);
      expect(payload.description).toBeNull();
      expect(payload.min_reps_default).toBeNull();
      expect(payload.rest_default_seconds).toBeNull();
      expect(payload.notes_default).toBeNull();
    });

    it('neither payload carries video_url (#717 Q6, #1380)', () => {
      expect(toExerciseCreatePayload(form, extras)).not.toHaveProperty('video_url');
      expect(toExerciseUpdatePayload(form, extras)).not.toHaveProperty('video_url');
      expect(pageSrc).not.toMatch(/method: 'PUT'[\s\S]{0,200}video_url/);
    });

    it('the two payloads agree on everything else', () => {
      expect(toExerciseCreatePayload(form, extras)).toEqual(toExerciseUpdatePayload(form, extras));
    });
  });

  describe('AC13 — no regression', () => {
    it('seeds the editor from the row it is editing', () => {
      const row = {
        name: 'Deadlift', description: null, video_url: null,
        min_reps_default: 3, max_reps_default: null, sets_default: 5,
        rest_default_seconds: null, notes_default: null, status: 'active',
      };
      expect(exerciseFormFromRow(row)).toEqual({
        name: 'Deadlift', description: '', video_url: '',
        min_reps_default: '3', max_reps_default: '', sets_default: '5',
        rest_default_seconds: '', notes_default: '', status: 'active',
        // #967: a row with no stored translations seeds an empty map.
        translations: {},
      });
    });

    it('leaves import, duplicate, clone and the status toggle alone', () => {
      expect(pageSrc).toContain('ImportExercisesModal');
      expect(pageSrc).toContain("t('import_system_exercises')");
      expect(pageSrc).toContain('function handleDuplicate(');
      expect(pageSrc).toContain('function handleClone(');
      expect(pageSrc).toContain('function handleToggleStatus(');
    });

    it('still gates the Add button on write access', () => {
      expect(pageSrc).toMatch(/onClick=\{openAdd\}[^>]*disabled=\{!canWrite/);
    });
  });
});
