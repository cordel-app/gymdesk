import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  MEMBER_PROFILE_FIELDS,
  emptyMemberEditForm,
  formatProfileDate,
  toMemberEditFormValues,
} from '../app/[locale]/members/memberProfile';

// Regression tests for #797 — the expanded Member card shows the complete
// Member Profile, read-only, and editing stays behind ⋮ → Edit.
//
// This repo has no component-test infra for apps/admin (see docs/architecture.md's
// TL;DR), so the structural half of this file scans the source the way
// promotions-section-editing.test.ts (#627) does, and the pure helpers in
// memberProfile.ts are exercised directly.

const MEMBERS_DIR = join(__dirname, '..', 'app', '[locale]', 'members');
const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

type Messages = Record<string, unknown>;

function loadLocale(code: string): Messages {
  return JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
}

// The sources deliberately name #797 and describe what the section must not
// contain, so every scan below runs on comment-free code.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function read(file: string): string {
  return stripComments(readFileSync(join(MEMBERS_DIR, file), 'utf-8'));
}

const expandedSrc = read('MemberExpandedRow.tsx');
const editFormSrc = read('MemberEditForm.tsx');
const layoutSrc = read('MemberProfileLayout.tsx');
const pageSrc = read('page.tsx');

/**
 * The JSX of the PROFILE <Section>, from its opening tag to its matching close.
 * The rest of the expanded row has had its own editing controls since long
 * before this ticket (Assign New Plan, Extend expiration), so "no editable
 * control" is asserted about this section, not about the whole card.
 */
function profileSection(): string {
  // The opening tag carries props now (#929 gave the first section
  // `divider={false}`), so match up to the label rather than the whole tag.
  const start = expandedSrc.indexOf("<Section label={t('members.section_profile')}");
  expect(start, 'no PROFILE section in the expanded Member row').toBeGreaterThan(-1);
  const end = expandedSrc.indexOf('</Section>', start);
  expect(end).toBeGreaterThan(start);
  return expandedSrc.slice(start, end);
}

describe('Members: PROFILE in the expanded card (#797)', () => {
  it('renders the Profile from the one shared field definition', () => {
    const section = profileSection();
    // #882: the field set reaches this section through the shared layout, which
    // is the one place MEMBER_PROFILE_FIELDS is walked for either mode.
    expect(section).toContain('<MemberProfileLayout');
    expect(layoutSrc).toContain('MEMBER_PROFILE_FIELDS.map');
    expect(expandedSrc).toContain("from './memberProfile'");
    expect(expandedSrc).toContain("from './MemberProfileLayout'");
  });

  it('is the first section of the expanded row', () => {
    const order = ['section_profile', 'section_account', 'section_membership_plans', 'section_billing_events'];
    const positions = order.map((key) => expandedSrc.indexOf(`t('members.${key}')`));
    for (const [i, pos] of positions.entries()) {
      expect(pos, `members.${order[i]} not rendered`).toBeGreaterThan(-1);
    }
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('shows the Member\'s centers and marks the default one', () => {
    const section = profileSection();
    expect(section).toContain("t('members.assigned_centers')");
    expect(section).toContain("t('members.default_center')");
    // Resolved by the API, whose fallback is the one implementation (#797).
    expect(expandedSrc).toContain('/centers`');
    expect(expandedSrc).not.toContain('soleActive');
  });

  it('contains no control that could modify Member data', () => {
    const section = profileSection();
    for (const control of ['<input', '<select', '<textarea', '<button', 'onChange', 'onClick', 'contentEditable']) {
      expect(section, `PROFILE must stay read-only, found ${control}`).not.toContain(control);
    }
  });

  it('adds no Edit affordance — ⋮ → Edit stays the only entry point', () => {
    const section = profileSection();
    expect(section).not.toContain("t('members.edit')");
    // The context menu still carries Edit, and it still opens the inline form.
    expect(pageSrc).toContain("items.push({ label: t('members.edit'), onClick: () => guardUnsaved(() => startEdit(m)) });");
    expect(pageSrc).toContain('<MemberEditForm');
    expect(pageSrc).toContain('editingId === m.id');
  });

  it('renders the Profile from the row the Edit form is seeded from', () => {
    // One Member representation: the page hands the list row to both.
    expect(pageSrc).toContain('setEditForm(toMemberEditFormValues(m));');
    expect(pageSrc).toContain('member={m}');
    expect(expandedSrc).toContain('member: MemberProfile');
    // No second read of the Member itself for the Profile's own fields.
    expect(expandedSrc).not.toContain('`/members/${memberId}`');
  });

  it('re-reads the centers after an edit is saved', () => {
    expect(pageSrc).toContain('setProfileVersion((v) => v + 1);');
    expect(pageSrc).toContain('profileVersion={profileVersion}');
    expect(expandedSrc).toContain('loadCenters();');
  });

  it('never renders null or undefined for a missing value', () => {
    const section = profileSection();
    // Every value in the section falls back to the screens' em dash.
    expect(section.match(/EMPTY_VALUE/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(expandedSrc).toMatch(/const EMPTY_VALUE = '\\u2014'/);
  });
});

describe('Members: the Profile field definition is shared (#797)', () => {
  it('covers every field the ticket lists', () => {
    expect(MEMBER_PROFILE_FIELDS.map((f) => f.key)).toEqual([
      'name',
      'phone',
      'date_of_birth',
      'gender',
      'address',
      'emergency_contact',
      'nif_nie_passport',
      'notes',
    ]);
  });

  it('is the field set the Edit form submits, so the two cannot drift apart', () => {
    // #882: the form writes every field through one keyed update rather than a
    // hand-written input per field, so a new field cannot reach only one half.
    expect(editFormSrc).toContain('onChange({ ...form, [field.key]: next })');
    expect(editFormSrc).toContain('const value = form[field.key];');
    for (const field of MEMBER_PROFILE_FIELDS) {
      expect(pageSrc, `saveEdit does not submit ${field.key}`).toContain(`${field.key}:`);
    }
    expect(Object.keys(emptyMemberEditForm).sort()).toEqual(MEMBER_PROFILE_FIELDS.map((f) => f.key).sort());
    expect(editFormSrc).toContain("from './memberProfile'");
  });

  it('every read-only label resolves in en, es and ca', () => {
    const labelKeys = [...MEMBER_PROFILE_FIELDS.map((f) => f.labelKey), 'section_profile', 'assigned_centers', 'default_center'];
    for (const code of LOCALE_CODES) {
      const members = loadLocale(code).members as Record<string, unknown>;
      for (const key of labelKeys) {
        expect(typeof members[key], `members.${key} missing from ${code}.json`).toBe('string');
      }
    }
  });

  it('uses a read-only label for Name, not the Edit form\'s required marker', () => {
    const nameField = MEMBER_PROFILE_FIELDS.find((f) => f.key === 'name')!;
    for (const code of LOCALE_CODES) {
      const members = loadLocale(code).members as Record<string, string>;
      expect(members[nameField.labelKey]).not.toContain('*');
    }
  });
});

describe('Members: Profile value formatting (#797)', () => {
  it('maps a persisted Member onto the Edit form\'s values', () => {
    expect(
      toMemberEditFormValues({
        name: 'Test1',
        phone: null,
        date_of_birth: '1990-05-04T00:00:00.000Z',
        gender: 'female',
        address: null,
        emergency_contact: null,
        nif_nie_passport: '12345678Z',
        notes: null,
      }),
    ).toEqual({
      name: 'Test1',
      phone: '',
      date_of_birth: '1990-05-04',
      gender: 'female',
      address: '',
      emergency_contact: '',
      nif_nie_passport: '12345678Z',
      notes: '',
    });
  });

  it('formats a date-only column without shifting it a day', () => {
    // new Date('1990-05-04') is UTC midnight, which prints as 3 May west of
    // Greenwich — wrong for a birth date.
    expect(formatProfileDate('1990-05-04')).toBe('04 May 1990');
    expect(formatProfileDate('1990-05-04T00:00:00.000Z')).toBe('04 May 1990');
  });

  it('reports a missing date as absent rather than as a formatted epoch', () => {
    expect(formatProfileDate(null)).toBeNull();
    expect(formatProfileDate('')).toBeNull();
    expect(formatProfileDate(undefined)).toBeNull();
  });
});
