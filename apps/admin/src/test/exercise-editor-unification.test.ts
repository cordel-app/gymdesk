import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  EXERCISE_CONFIGURATION_FIELDS,
  EXERCISE_FORM_SECTIONS,
  EXERCISE_GENERAL_FIELDS,
  RESULT_TYPE_SLUGS,
} from '@/components/exercises/exerciseForm';

// #806 — Exercises and Base Exercises are edited by the **same** editor.
//
// Two screens administer the same entity: the gym's `[locale]/exercises` and the
// platform's `[locale]/cordel/exercises`. Before this ticket each had its own
// form — the gym's carried General, Configuration, Allowed Result Types, Muscles
// and Media, the platform's carried Name and Description — so every improvement
// to one had to be made twice, and was not. There is now one implementation,
// `components/exercises/ExerciseEditor.tsx`, and one form-state hook beside it.
//
// This repo has no component-test infra for apps/admin (docs/architecture.md's
// TL;DR), so — like theme-editor-unification.test.ts (#678), which unified the
// Base Theme editor with the Custom Theme one — this pins the structure down by
// scanning the sources and the locale files.

const SRC = join(__dirname, '..');
const GYM_PAGE = join(SRC, 'app', '[locale]', 'exercises', 'page.tsx');
const BASE_PAGE = join(SRC, 'app', '[locale]', 'cordel', 'exercises', 'page.tsx');
const EDITOR = join(SRC, 'components', 'exercises', 'ExerciseEditor.tsx');
const HOOK = join(SRC, 'components', 'exercises', 'useExerciseEditorState.ts');
const IMAGE_FIELD = join(SRC, 'components', 'ExerciseImageField.tsx');
const VIDEO_FIELD = join(SRC, 'components', 'ExerciseVideoField.tsx');
const LOCALES_DIR = join(SRC, '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

const gymPage = stripComments(readFileSync(GYM_PAGE, 'utf-8'));
const basePage = stripComments(readFileSync(BASE_PAGE, 'utf-8'));
const editor = stripComments(readFileSync(EDITOR, 'utf-8'));
const hook = stripComments(readFileSync(HOOK, 'utf-8'));
const imageField = stripComments(readFileSync(IMAGE_FIELD, 'utf-8'));
const videoField = stripComments(readFileSync(VIDEO_FIELD, 'utf-8'));

const locales = Object.fromEntries(LOCALE_CODES.map((code) => [
  code,
  (JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8')).exercises ?? {}) as Record<string, string>,
]));

describe('AC1/AC7 — one Exercise editor, used by both screens', () => {
  it('both pages import the shared editor', () => {
    for (const [name, page] of [['gym', gymPage], ['base', basePage]] as const) {
      expect(page, name).toContain("from '@/components/exercises/ExerciseEditor'");
      expect(page, name).toContain('<ExerciseEditor');
    }
  });

  it('neither page keeps a form body of its own', () => {
    for (const [name, page] of [['gym', gymPage], ['base', basePage]] as const) {
      // The fields belong to the editor now: a page that still rendered one
      // would be the second implementation this ticket exists to remove.
      expect(page, `${name}: label_name`).not.toContain("t('label_name')");
      expect(page, `${name}: section_general`).not.toContain("t('section_general')");
      expect(page, `${name}: renderInlineForm`).not.toContain('renderInlineForm');
      expect(page, `${name}: renderExerciseForm`).not.toContain('renderExerciseForm');
    }
    // And the platform page's Name/Description-only form is gone with it.
    expect(basePage).not.toContain('interface EditForm');
    expect(basePage).not.toContain('emptyEditForm');
  });

  it('both pages seed and submit through the one form-state hook', () => {
    for (const [name, page] of [['gym', gymPage], ['base', basePage]] as const) {
      expect(page, name).toContain("from '@/components/exercises/useExerciseEditorState'");
      expect(page, name).toContain('useExerciseEditorState()');
      expect(page, name).toMatch(/\.reset\(null\)/);
      expect(page, name).toMatch(/\.submit\(async \(\) => \{/);
    }
  });

  it('the form declaration sits beside the editor, not inside one of its callers', () => {
    // The rule `components/nutritionLibrary/` already follows (#799): the shared
    // declaration moves up when a second page administers the same entity.
    for (const [name, page] of [['gym', gymPage], ['base', basePage]] as const) {
      expect(page, name).toContain("from '@/components/exercises/exerciseForm'");
      expect(page, name).not.toContain("from './exerciseForm'");
    }
  });
});

describe('AC2/AC3 — the same sections, fields and labels on both screens', () => {
  it('renders every declared section, in the declared order', () => {
    const positions = EXERCISE_FORM_SECTIONS.map((section) => editor.indexOf(`t('${section.labelKey}')`));
    expect(positions.every((p) => p > -1), `a section heading is missing: ${positions}`).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('renders every General and Configuration field', () => {
    for (const field of EXERCISE_GENERAL_FIELDS) expect(editor, field).toContain(`t('label_${field}')`);
    for (const field of EXERCISE_CONFIGURATION_FIELDS) expect(editor, field).toContain(`t('label_${field}')`);
  });

  it('renders Allowed Result Types through the shared label helper', () => {
    expect(editor).toContain('resultTypeLabel(rt,');
    for (const code of LOCALE_CODES) {
      for (const slug of RESULT_TYPE_SLUGS) {
        expect(locales[code][`result_type_${slug}`], `${code}.result_type_${slug}`).toBeTruthy();
      }
    }
  });

  it('renders the Muscles picker with its per-muscle role', () => {
    expect(editor).toContain("t('role_principal')");
    expect(editor).toContain("t('role_secondary')");
    // A key already stored on the exercise but no longer offered by the
    // catalogue still appears, so editing cannot silently drop it.
    expect(editor).toContain('const pickerKeys = [...muscleKeys,');
  });

  it('labels the muscles through one helper, so neither page humanises keys itself', () => {
    expect(hook).toContain('export function useMuscleLabel(');
    for (const [name, page] of [['gym', gymPage], ['base', basePage]] as const) {
      expect(page, name).toContain('useMuscleLabel(muscleKeys)');
      expect(page, name).not.toContain("useTranslations('muscles')");
    }
  });

  it('renders one error line, one Save/Cancel pair and one disabled-while-saving state', () => {
    expect(editor).toContain('{state.error &&');
    expect(editor).toContain("t('cancel')");
    expect(editor).toContain('disabled={state.saving}');
    expect(editor).toContain("{state.saving ? t('saving') : primaryLabel}");
    // Neither page renders its own.
    for (const [name, page] of [['gym', gymPage], ['base', basePage]] as const) {
      expect(page, name).not.toContain("t('saving')");
    }
  });
});

describe('AC4/AC5 — the API and permission differences are the parents’', () => {
  it('the editor names no endpoint at all', () => {
    expect(editor).not.toContain('apiFetch');
    expect(editor).not.toContain('/exercises');
    expect(editor).not.toContain('/platform/');
  });

  it('the gym page saves through the gym routes', () => {
    expect(gymPage).toContain("apiFetch<Exercise>('/exercises', {");
    expect(gymPage).toContain('`/exercises/${id}`');
  });

  it('the platform page saves through the platform routes', () => {
    expect(basePage).toContain("const API_BASE = '/platform/exercises'");
    expect(basePage).toContain('`${API_BASE}/${exercise.id}`');
    // Never a gym route, under any name.
    expect(basePage).not.toMatch(/`\/exercises\/\$\{/);
  });

  it('the editor makes no permission decision — the page gates the write', () => {
    expect(editor).not.toContain('useModuleAccess');
    expect(editor).not.toContain('canWrite');
    // The gym page still gates its Edit item and its media controls.
    expect(gymPage).toContain("useModuleAccess('TRAINING')");
    expect(gymPage).toMatch(/disabled=\{!canWrite\}/);
  });

  it('no `if base … else gym` branch is left in the shared UI (§5)', () => {
    for (const forbidden of ['gym_id', 'cloned_from_id', 'isBase', 'isSuperadmin']) {
      expect(editor, forbidden).not.toContain(forbidden);
    }
    // `mode` decides exactly one field, and nothing about ownership.
    expect(editor.match(/mode === /g) ?? []).toHaveLength(2);
  });
});

describe('AC6 — the Media UI is one implementation, pointed at two routes', () => {
  it('both pages render the same two controls', () => {
    for (const [name, page] of [['gym', gymPage], ['base', basePage]] as const) {
      expect(page, name).toContain('<ExerciseImageField');
      expect(page, name).toContain('<ExerciseVideoField');
      expect(page, name).toContain('<ExerciseMediaPair');
    }
  });

  it('the controls take their route root from the context and default to the gym’s', () => {
    for (const [name, field, kind] of [['image', imageField, 'image'], ['video', videoField, 'video']] as const) {
      expect(field, name).toContain("basePath = '/exercises'");
      expect(field, name).toContain(`\${basePath}/\${exerciseId}/${kind}`);
    }
    expect(basePage).toContain('basePath={API_BASE}');
  });

  it('a platform upload is not gated on a gym’s bucket', () => {
    // A Base Exercise's objects live in `cordel/Exercises/…`, which no gym's
    // storage settings reach.
    expect(basePage).toContain('requiresGymStorage={false}');
    expect(gymPage).not.toContain('requiresGymStorage');
    for (const field of [imageField, videoField]) {
      expect(field).toContain('requiresGymStorage = true');
      expect(field).toMatch(/const notConfigured = requiresGymStorage && activeGym != null/);
    }
  });

  it('neither page re-implements the browser-side preparation or its messages', () => {
    for (const [name, page] of [['gym', gymPage], ['base', basePage]] as const) {
      expect(page, name).not.toContain('prepareExerciseImage');
      expect(page, name).not.toContain('prepareExerciseVideo');
      expect(page, name).not.toContain('IMAGE_PROBLEM_MESSAGES');
      expect(page, name).not.toContain('VIDEO_PROBLEM_MESSAGES');
    }
    expect(imageField).toContain('prepareExerciseImage(file)');
    expect(videoField).toContain('prepareExerciseVideo(file)');
  });

  it('removing media asks first, on both screens, in every locale', () => {
    expect(imageField).toContain("message={t('image_confirm_remove')}");
    expect(videoField).toContain("message={t('video_confirm_remove')}");
    for (const code of LOCALE_CODES) {
      expect(locales[code].image_confirm_remove, `${code}.image_confirm_remove`).toBeTruthy();
      expect(locales[code].video_confirm_remove, `${code}.video_confirm_remove`).toBeTruthy();
    }
  });

  it('both creation cards stage the pair and upload it once the exercise exists', () => {
    expect(gymPage).toContain('`/exercises/${created.id}/image`');
    expect(gymPage).toContain('`/exercises/${created.id}/video`');
    expect(basePage).toContain('`${API_BASE}/${created.id}/image`');
    expect(basePage).toContain('`${API_BASE}/${created.id}/video`');
  });
});

describe('AC8/§9 — inline, never a modal', () => {
  it('the editor depends on no dialog', () => {
    expect(editor).not.toContain('CrudModal');
    expect(editor).not.toContain('modalStyle');
    expect(editor).not.toContain('overlayStyle');
  });

  it('both pages open it in the row', () => {
    expect(gymPage).toContain('function renderEditSection(');
    expect(basePage).toMatch(/renderExpanded=\{\(row\) => \(\s*\n\s*editingId === row\.id \?/);
    for (const [name, page] of [['gym', gymPage], ['base', basePage]] as const) {
      expect(page, name).not.toContain('CrudModal');
    }
  });

  it('`⋮ → Edit` is the only way in, on both screens (#797)', () => {
    expect(basePage).toMatch(/label: t\('edit'\), onClick: \(\) => openInlineEdit\(row\)/);
    // The read-only body of an expanded Base Exercise card holds no write
    // affordance — the play control aside, which is a read.
    const readOnlyStart = basePage.indexOf('function renderReadOnly(');
    const columnsStart = basePage.indexOf('const columns: Column<Exercise>[]');
    expect(readOnlyStart, 'renderReadOnly could not be located').toBeGreaterThan(-1);
    expect(columnsStart, 'the columns array could not be located').toBeGreaterThan(readOnlyStart);
    const readOnly = basePage.slice(readOnlyStart, columnsStart);
    expect(readOnly).not.toContain('<input');
    expect(readOnly).not.toContain('<select');
    expect(readOnly).not.toContain('onChange');
    expect(readOnly).not.toContain('Upload');
  });
});

describe('AC9 — ownership, import and the data model are untouched', () => {
  it('the gym page keeps its import, duplicate and clone actions', () => {
    expect(gymPage).toContain('ImportExercisesModal');
    expect(gymPage).toContain('function handleDuplicate(');
    expect(gymPage).toContain('function handleClone(');
    // And the System sourced / Custom badge it derives from `cloned_from_id`.
    expect(gymPage).toContain('ex.cloned_from_id != null');
  });

  it('the platform page offers neither, because a base exercise imports nothing', () => {
    expect(basePage).not.toContain('ImportExercisesModal');
    expect(basePage).not.toContain('cloned_from_id');
  });

  it('the platform catalogues are read from the platform router', () => {
    // Not `/muscles` + `/result-types`, which sit behind a gym's module access
    // and feature flags — a platform screen must not depend on those.
    expect(basePage).toContain('`${API_BASE}/lookups`');
    expect(basePage).not.toContain("apiFetch<ResultType[]>('/result-types')");
    // The gym page still reads its own two.
    expect(gymPage).toContain("apiFetch<{ key: string }[]>('/muscles')");
    expect(gymPage).toContain("apiFetch<ResultType[]>('/result-types')");
  });
});
