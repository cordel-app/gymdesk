import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  EXERCISE_CONFIGURATION_FIELDS,
  EXERCISE_EMPTY_VALUE,
  EXERCISE_FORM_SECTIONS,
  EXERCISE_GENERAL_FIELDS,
  exerciseDisplayValue,
  formatExerciseDate,
  formatExerciseTimestamp,
} from '@/components/exercises/exerciseForm';

// #965 — Base Exercise: the expanded card is the read-only counterpart of Edit,
// and `⋮ → Details` is the one place the technical metadata lives.
//
//   header     → name, description, created at / by, status, ⋮
//   expand     → the Edit view's five sections, values instead of controls
//   ⋮ Details  → Created/Modified At & By, the internal id, View Audit Log
//   ⋮ Edit     → the existing inline form, the only place anything changes
//
// This repo has no component-test infra for apps/admin (docs/architecture.md's
// TL;DR), so — like nutrition-library-read-only-expansion.test.ts (#799) — the
// structure is pinned by scanning the source, while the shared module's own pure
// parts (the orderings and the formatters) are exercised directly.

const SRC = join(__dirname, '..');
const SHARED = join(SRC, 'components', 'exercises');

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const read = (path: string) => stripComments(readFileSync(path, 'utf-8'));

const readOnlyView = read(join(SHARED, 'ExerciseReadOnlyView.tsx'));
const mediaPreview = read(join(SHARED, 'ExerciseMediaPreview.tsx'));
const detailsModal = read(join(SHARED, 'ExerciseDetailModal.tsx'));
const editor = read(join(SHARED, 'ExerciseEditor.tsx'));
const chrome = read(join(SHARED, 'exerciseFieldChrome.ts'));
const basePage = read(join(SRC, 'app', '[locale]', 'cordel', 'exercises', 'page.tsx'));
const gymPage = read(join(SRC, 'app', '[locale]', 'exercises', 'page.tsx'));

const PAGES = [['Base Exercises', basePage], ['gym Exercises', gymPage]] as const;
const LOCALE_CODES = ['en', 'es', 'ca'] as const;
const LOCALES_DIR = join(SRC, '..', 'locales', 'base');

function exercisesNamespace(code: string): Record<string, string> {
  const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
  return (messages.exercises ?? {}) as Record<string, string>;
}

describe('the expanded card is strictly read-only (§3, §13)', () => {
  it('holds no writing control of any kind', () => {
    for (const forbidden of ['<input', '<select', '<textarea', 'onChange', 'type="checkbox"', 'ExerciseImageField', 'ExerciseVideoField']) {
      expect(readOnlyView, `the read-only view must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('offers no Edit, Save or Cancel affordance — ⋮ → Edit is the only entry point', () => {
    for (const forbidden of ['onEdit', "t('edit')", "t('save')", "t('save_changes')", "t('cancel')"]) {
      expect(readOnlyView, `the read-only view must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('renders Allowed Result Types as spans, never as disabled checkboxes (§6)', () => {
    expect(readOnlyView).not.toContain('disabled');
    expect(readOnlyView).toMatch(/<span key=\{rt\.id\} style=\{exerciseOptionRowStyle\}>/);
  });

  it('shows the media and nothing that changes it (§8)', () => {
    // The preview is allowed exactly one control, and it is a *read*: the poster
    // doubles as the play button (#717 §8/§9).
    expect(mediaPreview).not.toContain("t('image_upload')");
    expect(mediaPreview).not.toContain("t('image_remove')");
    expect(mediaPreview).not.toContain("t('video_upload')");
    expect(mediaPreview).not.toContain("t('video_remove')");
    expect(mediaPreview).not.toContain('<input');
    expect((mediaPreview.match(/<button/g) ?? []).length).toBe(2);
  });
});

describe('it is the Edit view with the controls replaced by values (§2, §14, §15)', () => {
  it('renders every section of the form declaration, in the declared order', () => {
    const positions = EXERCISE_FORM_SECTIONS.map(({ labelKey }) => {
      const at = readOnlyView.indexOf(`{t('${labelKey}')}`);
      expect(at, `${labelKey} is missing from the read-only view`).toBeGreaterThan(-1);
      return at;
    });
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // MEDIA is last in both halves (#805 §9) — nothing may be appended after it.
    expect(EXERCISE_FORM_SECTIONS[EXERCISE_FORM_SECTIONS.length - 1].key).toBe('media');
  });

  it("renders every field of GENERAL and CONFIGURATION, under the form's own labels", () => {
    const labelFor: Record<string, string> = {
      name: 'label_name', description: 'label_description', status: 'label_status',
      min_reps_default: 'label_min_reps_default', max_reps_default: 'label_max_reps_default',
      sets_default: 'label_sets_default', rest_default_seconds: 'label_rest_default_seconds',
      notes_default: 'label_notes_default',
    };
    for (const field of [...EXERCISE_GENERAL_FIELDS, ...EXERCISE_CONFIGURATION_FIELDS]) {
      expect(readOnlyView, `${field} is missing`).toContain(`{t('${labelFor[field]}')}`);
    }
  });

  it('shares one chrome module with the editor, so neither can be restyled alone', () => {
    for (const [name, src] of [['the editor', editor], ['the read-only view', readOnlyView]] as const) {
      expect(src, `${name} must import the shared field chrome`).toContain("from './exerciseFieldChrome'");
    }
    // The grids and the label are declared once, in that module.
    for (const token of ['exerciseFieldGridStyle', 'exerciseFieldLabelStyle', 'exerciseResultTypeGridStyle', 'exerciseMediaGridStyle']) {
      expect(chrome, `${token} belongs in the chrome module`).toContain(`export const ${token}`);
    }
    // And neither half restates a grid template of its own.
    for (const [name, src] of [['the editor', editor], ['the read-only view', readOnlyView]] as const) {
      expect(src, `${name} must not restate the field grid`).not.toContain("gridTemplateColumns: '1fr 1fr'");
      expect(src, `${name} must not restate the wide-field span`).not.toContain("gridColumn: '1 / -1'");
    }
  });

  it('keeps the read-only value in the box its input occupies (#929)', () => {
    expect(chrome).toContain("from '@/components/formChrome'");
    expect(chrome).toMatch(/exerciseFieldValueStyle[\s\S]*?\.\.\.formValueStyle/);
  });
});

describe('the expanded card carries no technical metadata (§9, §10)', () => {
  it('shows no timestamp, no internal id and no Audit Log link', () => {
    for (const forbidden of ["t('col_created_at')", "t('detail_modified_at')", "t('col_created_by')", "t('detail_modified_by')", 'ViewAuditLogButton', "t('detail_exercise_id')"]) {
      expect(readOnlyView, `the read-only view must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('and neither page renders the deep link outside the Details modal', () => {
    for (const [name, src] of PAGES) {
      expect(src, `${name} must not render the audit link itself`).not.toContain('ViewAuditLogButton');
      expect(src, `${name} must open the shared Details modal`).toContain('<ExerciseDetailModal');
    }
  });
});

describe('⋮ → Details is the one place the metadata lives (§11, §12)', () => {
  it('reports the full audit pair plus the internal identifier', () => {
    for (const key of ['detail_exercise_id', 'col_created_at', 'col_created_by', 'detail_modified_at', 'detail_modified_by']) {
      expect(detailsModal, `${key} is missing from the Details modal`).toContain(`{t('${key}')}`);
    }
    expect(detailsModal).toContain('<ViewAuditLogButton entityType="exercise"');
  });

  it('no longer restates the exercise configuration the card already shows (§12)', () => {
    for (const forbidden of ["t('section_configuration')", "t('label_result_types')", "t('section_muscles')", "t('section_media')", "t('label_min_reps_default')"]) {
      expect(detailsModal, `the Details modal must not restate ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('renders the list row it was handed rather than reading the exercise again', () => {
    expect(detailsModal).not.toContain('useApiClient');
    expect(detailsModal).not.toContain('apiFetch');
    expect(detailsModal).not.toContain('useEffect');
    for (const [name, src] of PAGES) {
      expect(src, `${name} must hand the modal its row`).toContain('exercise={detailFor}');
    }
  });

  it('is opened from the context menu, which no longer uses Details to expand', () => {
    expect(basePage).toContain("{ label: t('details'), onClick: () => setDetailFor(row) }");
    expect(basePage).not.toContain("{ label: t('details'), onClick: () => toggleExpand(row.id) }");
  });
});

describe('the collapsed header is the concise summary (§1)', () => {
  it('carries name, description, created at, created by, status and the ⋮ menu', () => {
    const columnsStart = basePage.indexOf('const columns: Column<Exercise>[]');
    expect(columnsStart).toBeGreaterThan(-1);
    const columns = basePage.slice(columnsStart, basePage.indexOf('return (', columnsStart));
    for (const key of ['col_name', 'col_description', 'col_created_at', 'col_created_by', 'col_status']) {
      expect(columns, `${key} is missing from the header`).toContain(`t('${key}')`);
    }
    expect(columns).toContain('<ContextMenu');
    // And it stays compact: no configuration, no media, no metadata beyond those.
    for (const forbidden of ['image_url', 'video_url', 'allowed_result_types', 'muscles', 'modified_at']) {
      expect(columns, `the header must not carry ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('reads Created By from the column the API returns (migration 208)', () => {
    expect(basePage).toContain('created_by_name: string | null;');
    expect(basePage).toContain('exerciseDisplayValue(row.created_by_name)');
  });
});

describe('one read-only view for both Exercise pages (#806)', () => {
  it('both pages render it, and neither keeps a second one', () => {
    for (const [name, src] of PAGES) {
      expect(src, `${name} must render the shared read-only view`).toContain('<ExerciseReadOnlyView');
      expect(src, `${name} must render the shared media preview`).toContain('<ExerciseMediaPreview');
    }
  });

  it('and the shared components name no endpoint and decide no permission', () => {
    for (const [name, src] of [['the read-only view', readOnlyView], ['the media preview', mediaPreview], ['the Details modal', detailsModal]] as const) {
      expect(src, `${name} must not name an endpoint`).not.toContain('/platform/exercises');
      expect(src, `${name} must not name an endpoint`).not.toContain('apiFetch');
      expect(src, `${name} must not decide a permission`).not.toContain('canWrite');
      expect(src, `${name} must not branch on ownership`).not.toContain('gym_id');
    }
  });

  it("which Audit Log the modal opens is the page's decision, not the modal's", () => {
    expect(detailsModal).toContain('scope = \'gym\'');
    expect(basePage).toContain('scope="platform"');
    expect(gymPage).not.toContain('scope="platform"');
  });
});

describe('the shared declaration (pure)', () => {
  it('formats an empty value as the em dash', () => {
    expect(EXERCISE_EMPTY_VALUE).toBe('—');
    expect(exerciseDisplayValue(null)).toBe(EXERCISE_EMPTY_VALUE);
    expect(exerciseDisplayValue('   ')).toBe(EXERCISE_EMPTY_VALUE);
    expect(exerciseDisplayValue('Bench Press')).toBe('Bench Press');
    // A numeric default of 0 is a value, not an empty one.
    expect(exerciseDisplayValue(0)).toBe('0');
    expect(exerciseDisplayValue(12)).toBe('12');
  });

  it('reads a MySQL DATETIME as UTC rather than as local time', () => {
    const formatted = formatExerciseTimestamp('2026-09-26 15:50:00');
    expect(formatted).not.toBe(EXERCISE_EMPTY_VALUE);
    expect(new Date('2026-09-26T15:50:00Z').toLocaleString()).toBe(formatted);
    expect(formatExerciseTimestamp(null)).toBe(EXERCISE_EMPTY_VALUE);
    expect(formatExerciseTimestamp('not a date')).toBe(EXERCISE_EMPTY_VALUE);
  });

  it('shows a date alone in a list column', () => {
    expect(formatExerciseDate('2026-09-26 15:50:00')).toBe('2026-09-26');
    expect(formatExerciseDate(null)).toBe(EXERCISE_EMPTY_VALUE);
  });
});

describe('locales', () => {
  const keys = ['section_audit', 'detail_exercise_id', 'close', 'image_view_full_size', 'video_play'];

  it.each(LOCALE_CODES)('%s carries every key the new surfaces resolve', (code) => {
    const ns = exercisesNamespace(code);
    for (const key of keys) {
      expect(ns[key], `${code}.exercises.${key}`).toBeTruthy();
    }
    // The size is interpolated, never baked into the sentence.
    expect(ns.image_view_full_size).toContain('{size}');
  });
});
