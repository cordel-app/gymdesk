import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { MEMBER_PROFILE_FIELDS } from '../app/[locale]/members/memberProfile';

// Regression tests for #882 — the read-only Member Profile is the Edit layout
// with the inputs replaced by values, not a second, compact list of its own.
//
// This repo has no component-test infra for apps/admin (see docs/architecture.md's
// TL;DR), so the structural assertions scan the source the way
// member-expanded-profile.test.ts (#797) does, and the shared declaration in
// memberProfile.ts is exercised directly.

const MEMBERS_DIR = join(__dirname, '..', 'app', '[locale]', 'members');
const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function read(file: string): string {
  return stripComments(readFileSync(join(MEMBERS_DIR, file), 'utf-8'));
}

const layoutSrc = read('MemberProfileLayout.tsx');
const expandedSrc = read('MemberExpandedRow.tsx');
const editFormSrc = read('MemberEditForm.tsx');
const pageSrc = read('page.tsx');

describe('Members: one Profile layout for both modes (#882)', () => {
  it('is rendered by the read-only section and by the Edit form', () => {
    for (const [name, src] of [['expanded row', expandedSrc], ['Edit form', editFormSrc]] as const) {
      expect(src, `${name} does not render the shared layout`).toContain('<MemberProfileLayout');
      expect(src).toContain("from './MemberProfileLayout'");
    }
  });

  it('is the only place the grid, the labels and the full-width Notes are declared', () => {
    // The layout owns them...
    expect(layoutSrc).toContain('repeat(auto-fit, minmax(200px, 1fr))');
    expect(layoutSrc).toContain("gridColumn: '1 / -1'");
    expect(layoutSrc).toContain('profileFieldLabelStyle');
    // ...so neither half restates them, which is how the two came to differ.
    for (const [name, src] of [['expanded row', expandedSrc], ['Edit form', editFormSrc]] as const) {
      expect(src, `${name} declares its own Profile grid`).not.toContain('minmax(200px, 1fr)');
      expect(src, `${name} declares its own full-width cell`).not.toContain("gridColumn: '1 / -1'");
      expect(src, `${name} declares its own field label style`).not.toContain('inlineLabelStyle');
    }
  });

  it('walks the fields once, in the declared order, for both modes', () => {
    expect(layoutSrc.match(/MEMBER_PROFILE_FIELDS\.map/g)?.length).toBe(1);
    expect(expandedSrc).not.toContain('MEMBER_PROFILE_FIELDS');
    expect(editFormSrc).not.toContain('MEMBER_PROFILE_FIELDS');
  });

  it('places Assigned Centers and Default Center in the layout, not in either half', () => {
    expect(layoutSrc).toContain('centers.assignedLabel');
    expect(layoutSrc).toContain('centers.defaultLabel');
    for (const src of [expandedSrc, editFormSrc]) {
      expect(src).toContain('assignedLabel:');
      expect(src).toContain('defaultLabel:');
    }
  });

  it('holds no control of its own — the cell contents come from the caller', () => {
    for (const control of ['<input', '<select', '<textarea', '<button', 'onChange', 'onClick', 'useState']) {
      expect(layoutSrc, `the layout must stay presentational, found ${control}`).not.toContain(control);
    }
  });
});

describe('Members: the Profile is rendered once per page (#882)', () => {
  it('stands the read-only section down while the Edit form is open', () => {
    expect(expandedSrc).toContain('{!editing && (');
    expect(expandedSrc).toContain('editing: boolean;');
    expect(pageSrc).toContain('editing={editingId === m.id}');
    // The same condition opens the form, so the two can never both render —
    // #961 scopes it to the Profile tab, which is the tab that form writes.
    expect(pageSrc).toContain("{activeTab === 'profile' && editingId === m.id && (");
  });

  it('keeps ⋮ → Edit as the only entry point into the form', () => {
    expect(pageSrc).toContain("items.push({ label: t('members.edit'), onClick: () => guardUnsaved(() => startEdit(m)) });");
  });
});

describe('Members: the read-only Profile shows values, not controls (#882)', () => {
  it('renders each value in the layout cell the input occupies', () => {
    expect(expandedSrc).toContain('profileValueStyle');
    expect(layoutSrc).toContain('profileValueStyle');
  });

  it('shows no help text meant for filling a field in', () => {
    const docField = MEMBER_PROFILE_FIELDS.find((f) => f.key === 'nif_nie_passport')!;
    expect(docField.helpKey).toBe('help_document');
    // The help sentence is the Edit form's; reading a value never explains it.
    expect(editFormSrc).toContain('t(field.helpKey)');
    expect(expandedSrc).not.toContain('helpKey');
  });
});

describe('Members: the field declaration carries both modes\' labels (#882)', () => {
  it('gives every field a read-only label and an Edit label', () => {
    for (const field of MEMBER_PROFILE_FIELDS) {
      expect(typeof field.labelKey, `${field.key} has no read-only label`).toBe('string');
      expect(typeof field.editLabelKey, `${field.key} has no Edit label`).toBe('string');
    }
  });

  it('resolves every label, placeholder and help key in en, es and ca', () => {
    const keys = MEMBER_PROFILE_FIELDS.flatMap((f) =>
      [f.labelKey, f.editLabelKey, f.placeholderKey, f.helpKey].filter((k): k is string => !!k),
    );
    for (const code of LOCALE_CODES) {
      const members = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8')).members as Record<string, unknown>;
      for (const key of keys) {
        expect(typeof members[key], `members.${key} missing from ${code}.json`).toBe('string');
      }
    }
  });

  it('marks Name as required only in the Edit form\'s label', () => {
    const name = MEMBER_PROFILE_FIELDS.find((f) => f.key === 'name')!;
    const members = JSON.parse(readFileSync(join(LOCALES_DIR, 'en.json'), 'utf-8')).members as Record<string, string>;
    expect(members[name.editLabelKey]).toContain('*');
    expect(members[name.labelKey]).not.toContain('*');
  });

  it('takes each mode\'s label from the declaration rather than the JSX', () => {
    expect(editFormSrc).toContain('t(field.editLabelKey)');
    expect(expandedSrc).toContain('t(`members.${f.labelKey}`)');
  });
});
