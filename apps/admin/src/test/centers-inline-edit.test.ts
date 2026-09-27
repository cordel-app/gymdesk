import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  CENTER_EDITABLE_FIELDS,
  CENTER_PROFILE_FIELDS,
  CENTER_PROFILE_SECTIONS,
  CENTER_STATUSES,
  EMPTY_VALUE,
  formatCenterField,
  formatCenterTheme,
  isCenterFormValid,
  toCenterEditFormValues,
  toCenterUpdatePayload,
} from '@/app/[locale]/centers/centerProfile';

// #800 — `⋮ → Edit` expands the Center row into an inline form; the Edit
// Center modal is gone. Expanding the row still only reads (#797/#798).
//
// apps/admin has no component-test infra (docs/architecture.md TL;DR), so the
// structural half is pinned by scanning the page source the way
// staff-expanded-profile.test.ts does; the shared field definition, its
// formatters and the payload mapping are pure, so they are exercised directly.

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const CENTERS_DIR = join(__dirname, '..', 'app', '[locale]', 'centers');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const rawPageSrc = readFileSync(join(CENTERS_DIR, 'page.tsx'), 'utf-8');
const pageSrc = stripComments(rawPageSrc);

function centersNamespace(code: string): Record<string, string> {
  const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
  return (messages.centers ?? {}) as Record<string, string>;
}

const locales = Object.fromEntries(LOCALE_CODES.map((c) => [c, centersNamespace(c)]));

/** The source between two markers, comments stripped. */
function slice(from: string, to: string): string {
  const start = pageSrc.indexOf(from);
  const end = pageSrc.indexOf(to, start + from.length);
  expect(start, `marker not found: ${from}`).toBeGreaterThan(-1);
  expect(end, `marker not found after ${from}: ${to}`).toBeGreaterThan(start);
  return pageSrc.slice(start, end);
}

/** Everything that renders the expanded (read-only) card. */
const readOnlySrc = slice('function ReadRow(', 'function renderInlineEditor(');
/** Everything that renders the inline Edit form. */
const editorSrc = slice('function renderInlineEditor(', 'function renderRow(');

describe('Centers: inline editing (#800)', () => {
  describe('the Edit Center modal is gone', () => {
    it('never renders a modal for editing', () => {
      expect(pageSrc).not.toContain("t('modal_edit')");
      expect(pageSrc).not.toContain("t('modal_add')");
      expect(pageSrc).not.toContain('setEditCenter');
      expect(pageSrc).not.toContain('editCenter');
    });

    it('keeps CrudModal only for the Details view', () => {
      const modalUses = [...pageSrc.matchAll(/<CrudModal\b/g)];
      expect(modalUses).toHaveLength(1);
      expect(pageSrc).toContain("title={t('details_title')}");
      // The modal-only form helpers are no longer imported.
      expect(pageSrc).not.toContain('FormLabel');
      expect(pageSrc).not.toContain('FormInput');
    });
  });

  describe('expanding reads, ⋮ → Edit writes', () => {
    it('tracks the read-only expansion and the form separately', () => {
      expect(pageSrc).toContain('const [expandedId, setExpandedId] = useState<number | null>(null)');
      expect(pageSrc).toContain('const [editingId, setEditingId] = useState<number | null>(null)');
    });

    it('expands without seeding the form — expanding cannot start an edit', () => {
      const openExpand = slice('function openExpand(', 'function startEdit(');
      expect(openExpand).not.toContain('setForm(toCenter');
      expect(openExpand).toContain('setEditingId(null)');
    });

    it('seeds the form only from startEdit, through the shared mapping, and collapses the read-only view', () => {
      const startEdit = slice('function startEdit(', 'function cancelEdit()');
      expect(startEdit).toContain('setForm(toCenterEditFormValues(center))');
      expect(startEdit).toContain('setExpandedId(null)');
      expect(startEdit).toContain('setEditingId(center.id)');
    });

    it('renders the editor only for the Center being edited (AC11, AC12)', () => {
      expect(pageSrc).toContain('const isEditing = editingId === center.id');
      expect(pageSrc).toContain(
        '{isEditing ? renderInlineEditor(center) : isExpanded ? renderReadOnlyProfile(center) : null}',
      );
    });

    it('does not toggle the read-only view from the header while the row is being edited', () => {
      expect(pageSrc).toContain('onClick={() => { if (!isEditing) openExpand(center); }}');
    });

    it('offers Edit as a context-menu item wired to startEdit, gated like every write action (AC10, AC13)', () => {
      expect(pageSrc).toMatch(
        /\{ label: t\('edit'\), onClick: \(\) => startEdit\(center\), disabled: !canWrite, title: readOnlyTitle \}/,
      );
    });

    it('keeps the other context-menu items', () => {
      for (const key of ["t('details')", "t('view_members')", "t('delete')"]) {
        expect(pageSrc).toContain(key);
      }
    });
  });

  describe('the expanded content is strictly read-only', () => {
    it.each(['<input', '<select', '<textarea', '<button', 'onChange', 'onClick', 'type="checkbox"'])(
      'contains no %s',
      (token) => {
        expect(readOnlySrc).not.toContain(token);
      },
    );

    it('offers no Save, Cancel or Edit affordance', () => {
      for (const key of ["t('save_changes')", "t('saving')", "t('cancel')", "t('edit')"]) {
        expect(readOnlySrc).not.toContain(key);
      }
      expect(readOnlySrc).not.toContain('handleSaveEdit');
      expect(readOnlySrc).not.toContain('patchForm');
    });

    it('renders the Center from the row, not from the form being edited', () => {
      expect(readOnlySrc).not.toContain('form.');
      expect(readOnlySrc).toContain('formatCenterField(center, field');
    });
  });

  describe('the inline form', () => {
    it('renders a control for every editable field and for no other (AC3)', () => {
      for (const field of CENTER_EDITABLE_FIELDS) {
        expect(editorSrc + pageSrc, `${field.key} has no control`).toContain(`case '${field.key}':`);
        expect(pageSrc, `${field.key} is not written back to the form`).toContain(`patchForm({ ${field.key}:`);
      }
      for (const field of CENTER_PROFILE_FIELDS.filter((f) => !f.editable)) {
        expect(pageSrc, `${field.key} must stay read-only`).not.toContain(`patchForm({ ${field.key}:`);
      }
    });

    it('renders Save Changes and Cancel inside the expanded row (AC4, AC5)', () => {
      expect(editorSrc).toContain("t('cancel')");
      expect(editorSrc).toContain("t('save_changes')");
      expect(editorSrc).toContain('onClick={cancelEdit}');
      expect(editorSrc).toContain('onClick={handleSaveEdit}');
    });

    it('shows the saving state and blocks a duplicate submission (AC7)', () => {
      expect(editorSrc).toContain('disabled={!canWrite || saving}');
      expect(editorSrc).toContain("{saving ? t('saving') : t('save_changes')}");
    });

    it('renders the error beside the form rather than in a toast (AC8)', () => {
      expect(editorSrc).toContain('{formError &&');
    });

    it('associates every label with its control', () => {
      expect(editorSrc).toContain('htmlFor={`center-${center.id}-${field.key}`}');
      expect(pageSrc).toContain('const id = `center-${center.id}-${key}`');
    });

    it('lays the fields out responsively rather than at a fixed width', () => {
      expect(pageSrc).toContain("gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))'");
      expect(pageSrc).toContain("boxSizing: 'border-box'");
    });
  });

  describe('save and cancel', () => {
    it('reuses the existing update endpoint and adds no other Center route (AC14)', () => {
      expect(pageSrc).toContain('apiFetch(`/centers/${editingId}`, {');
      expect(pageSrc).toContain("method: 'PUT'");
      const calls = [...rawPageSrc.matchAll(/apiFetch(?:<[^>]*>)?\(`?\/centers[^`'"]*/g)].map((m) => m[0]);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call).toMatch(/\/centers(\?|\$\{|\/\$\{|$)/);
      }
    });

    it('submits exactly the shared payload', () => {
      expect(pageSrc).toContain('body: JSON.stringify(toCenterUpdatePayload(form))');
    });

    it('leaves edit mode and refreshes the list on success (AC4)', () => {
      const save = slice('async function handleSaveEdit()', 'async function handleDelete()');
      expect(save).toContain('setEditingId(null)');
      expect(save).toContain('load();');
      expect(save).toContain('refreshCenters();');
    });

    it('keeps the form open with the user’s input when the update fails (AC8)', () => {
      const save = slice('async function handleSaveEdit()', 'async function handleDelete()');
      const catchBlock = save.slice(save.indexOf('catch'));
      expect(catchBlock).toContain('setFormError');
      expect(catchBlock).not.toContain('setEditingId(null)');
      expect(catchBlock).not.toContain('setForm(null)');
    });

    it('cancels without an API request (AC5)', () => {
      const cancel = slice('function cancelEdit()', 'async function handleSaveEdit()');
      expect(cancel).not.toContain('apiFetch');
      expect(cancel).toContain('setEditingId(null)');
      expect(cancel).toContain('setForm(null)');
      expect(cancel).toContain('setFormError(null)');
    });

    it('drops a newly added Center straight into its inline form instead of a modal', () => {
      const add = slice('async function handleAdd()', 'function openExpand(');
      expect(add).toContain('startEdit(row)');
      expect(add).not.toContain('CrudModal');
    });

    it('closes an open form when the Center being edited is deleted', () => {
      const del = slice('async function handleDelete()', 'function themeLabel(');
      expect(del).toContain('if (editingId === deleting.id) cancelEdit();');
    });
  });

  describe('the field set is declared once', () => {
    it('is imported from the shared module by the page', () => {
      expect(pageSrc).toContain("from './centerProfile'");
      expect(pageSrc).toContain('interface Center extends CenterProfile');
      expect(pageSrc).toContain('CENTER_PROFILE_SECTIONS.map((section)');
    });

    it('lists every field exactly once', () => {
      const keys = CENTER_PROFILE_FIELDS.map((f) => f.key);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it('orders the editable fields the way the ticket specifies', () => {
      expect(CENTER_EDITABLE_FIELDS.map((f) => f.key)).toEqual([
        'name', 'email', 'phone', 'address', 'status', 'theme_id',
      ]);
    });

    it('marks Code and Created By read-only — no control has ever edited them', () => {
      expect(CENTER_PROFILE_FIELDS.filter((f) => !f.editable).map((f) => f.key).sort())
        .toEqual(['code', 'created_by_name']);
    });

    it('has an en/es/ca label for every field and section', () => {
      const keys = [
        ...CENTER_PROFILE_SECTIONS.map((s) => s.titleKey),
        ...CENTER_PROFILE_FIELDS.map((f) => f.labelKey),
        'edit',
        'cancel',
        'saving',
        'save_changes',
        'theme_inherited_suffix',
        'theme_none',
      ];
      for (const code of LOCALE_CODES) {
        for (const key of keys) {
          expect(locales[code][key], `${code}.centers.${key} is missing`).toBeTruthy();
        }
      }
    });

    it('drops the modal-only labels from no locale — they are still used by the Add flow’s naming', () => {
      // `new_center_name` seeds the POST; the modal titles are the only strings
      // this ticket stops using, and leaving them in the catalogue is harmless.
      for (const code of LOCALE_CODES) {
        expect(locales[code]['new_center_name']).toBeTruthy();
      }
    });
  });

  describe('value formatting', () => {
    const field = (key: string) => CENTER_PROFILE_FIELDS.find((f) => f.key === key)!;
    const translateStatus = (key: string) => `t:${key}`;
    const inherited = '(Inherited)';

    it('never renders null, undefined or an empty string', () => {
      for (const f of CENTER_PROFILE_FIELDS) {
        for (const value of [null, undefined, '']) {
          const out = formatCenterField({ [f.key]: value } as any, f, translateStatus, inherited);
          expect(out).not.toMatch(/null|undefined|NaN|Invalid/);
          if (f.format !== 'theme') expect(out).toBe(EMPTY_VALUE);
        }
        expect(formatCenterField({}, f, translateStatus, inherited)).not.toMatch(/null|undefined/);
      }
    });

    it('translates Status with the keys the form’s select uses', () => {
      for (const status of CENTER_STATUSES) {
        expect(formatCenterField({ status } as any, field('status'), translateStatus, inherited))
          .toBe(`t:${status}`);
      }
    });

    it('reads the Theme as the Center’s own, or the gym’s marked inherited', () => {
      expect(formatCenterTheme({ theme_id: 'abc', theme_name: 'Crimson', gym_theme_name: 'Ocean' }, inherited))
        .toBe('Crimson');
      expect(formatCenterTheme({ theme_id: null, theme_name: null, gym_theme_name: 'Ocean' }, inherited))
        .toBe('Ocean (Inherited)');
      expect(formatCenterTheme({ theme_id: null, theme_name: null, gym_theme_name: null }, inherited))
        .toBe(`${EMPTY_VALUE} (Inherited)`);
      // A theme_id whose name the list did not resolve still reads as inherited
      // rather than as the raw UUID.
      expect(formatCenterTheme({ theme_id: 'abc', theme_name: null, gym_theme_name: 'Ocean' }, inherited))
        .toBe('Ocean (Inherited)');
    });
  });

  describe('the persisted row → form mapping', () => {
    const row = {
      name: 'Downtown',
      code: 'DT',
      address: 'Main St 1',
      phone: '+34 600 000 000',
      email: 'downtown@example.com',
      status: 'inactive' as const,
      theme_id: 'theme-uuid',
    };

    it('seeds every control with the persisted value (AC2)', () => {
      expect(toCenterEditFormValues(row)).toEqual(row);
    });

    it('never seeds a control with null — every input is controlled', () => {
      const values = toCenterEditFormValues({
        name: 'Empty', code: null, address: null, phone: null, email: null,
        status: 'active', theme_id: null,
      });
      expect(values).toEqual({
        name: 'Empty', code: '', address: '', phone: '', email: '', status: 'active', theme_id: '',
      });
    });

    it('submits the same payload the modal did — trimmed, emptied fields cleared to null (AC14)', () => {
      expect(toCenterUpdatePayload({
        name: '  Downtown  ', code: ' DT ', address: '  ', phone: '', email: ' a@b.c ',
        status: 'inactive', theme_id: '',
      })).toEqual({
        name: 'Downtown', code: 'DT', address: null, phone: null, email: 'a@b.c',
        status: 'inactive', theme_id: null,
      });
    });

    it('carries `code` through untouched although no control edits it', () => {
      expect(toCenterUpdatePayload(toCenterEditFormValues(row)).code).toBe('DT');
    });

    it('keeps the modal’s one client-side rule: a Center must keep a name (AC6)', () => {
      expect(isCenterFormValid({ ...toCenterEditFormValues(row), name: '   ' })).toBe(false);
      expect(isCenterFormValid(toCenterEditFormValues(row))).toBe(true);
    });
  });
});
