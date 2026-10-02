import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  MEMBER_EDITABLE_PROFILE_FIELDS,
  MEMBER_PROFILE_FIELDS,
  emptyMemberEditForm,
  newMemberAnnounceKey,
  newMemberValueKey,
} from '../app/[locale]/members/memberProfile';

// Regression tests for #927 — the Member's calculated `New Member` status, in
// the Profile and in the member header, from one value.
//
// This repo has no component-test infra for apps/admin (see docs/architecture.md's
// TL;DR), so the structural assertions scan the source the way
// member-profile-layout.test.ts (#882) does, and the pure helpers in
// memberProfile.ts are exercised directly.

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

describe('Members: New Member is part of the one Profile declaration (#927 §1)', () => {
  it('is the last field of the Profile, as the ticket draws it', () => {
    expect(MEMBER_PROFILE_FIELDS.at(-1)!.key).toBe('new_member');
  });

  it('is declared calculated, so neither half may put a control under it', () => {
    const field = MEMBER_PROFILE_FIELDS.find((f) => f.key === 'new_member')!;
    expect(field.calculated).toBe(true);
    expect(field.placeholderKey).toBeUndefined();
    expect(field.helpKey).toBeUndefined();
    // One label for both modes: a value nobody supplies is neither required
    // nor optional, so the Edit form's required marker has nothing to mark.
    expect(field.editLabelKey).toBe(field.labelKey);
  });

  it('is laid out by the shared layout through its own callback', () => {
    // #960 — the calculated cell is laid out inline, so the branch is a JSX
    // block rather than one expression; what matters is that it is still the
    // layout that chooses the callback, and that `renderField` is the other arm.
    expect(layoutSrc).toContain('field.calculated ? (');
    expect(layoutSrc).toContain('renderCalculated(field)');
    for (const [name, src] of [['expanded row', expandedSrc], ['Edit form', editFormSrc]] as const) {
      expect(src, `${name} does not render the calculated cell`).toContain('renderCalculated=');
      expect(src).toContain('<NewMemberValue');
    }
  });

  it('is rendered as a value, never as a checkbox input', () => {
    expect(layoutSrc).not.toContain("type=\"checkbox\"");
    const valueCell = layoutSrc.slice(layoutSrc.indexOf('export function NewMemberValue'));
    for (const control of ['<input', '<button', 'onChange', 'onClick']) {
      expect(valueCell, `the New Member cell must stay read-only, found ${control}`).not.toContain(control);
    }
  });
});

describe('Members: New Member is never editable (#927 §4)', () => {
  it('has no form value, so there is nothing to type into', () => {
    expect(Object.keys(emptyMemberEditForm)).not.toContain('new_member');
    expect(MEMBER_EDITABLE_PROFILE_FIELDS.map((f) => f.key)).not.toContain('new_member');
  });

  it('is not part of the payload the Edit form submits', () => {
    const save = pageSrc.slice(pageSrc.indexOf('async function saveEdit()'), pageSrc.indexOf('async function saveEdit()') + 1600);
    expect(save).not.toContain('new_member');
    expect(save).not.toContain('is_new_member');
  });
});

describe('Members: one value in both places (#927 §2/§5)', () => {
  it('shows the badge in the member header, from the row\'s own field', () => {
    expect(pageSrc).toContain('m.is_new_member && (');
    expect(pageSrc).toContain("t('members.new_member_badge')");
    // The existing badge voice, not a look of its own (#913/#724).
    expect(pageSrc).toContain('listNameBadgeAccentStyle');
  });

  it('reads the Profile value off the same row the badge reads', () => {
    expect(expandedSrc).toContain('member.is_new_member');
    expect(pageSrc).toContain('isNewMember={m.is_new_member}');
    expect(editFormSrc).toContain('isNewMember: boolean;');
  });

  it('calculates nothing in the frontend — the status arrives on the row', () => {
    for (const [name, src] of [
      ['page', pageSrc], ['expanded row', expandedSrc], ['Edit form', editFormSrc],
    ] as const) {
      for (const giveaway of ['MONTH', 'setMonth', 'getMonth', 'cutoff']) {
        expect(src, `${name} derives the New Member window itself`).not.toContain(giveaway);
      }
    }
  });
});

describe('Members: the New Member value and its labels (#927)', () => {
  it('reads Yes or No — #960 replaced the glyph with a chip', () => {
    expect(newMemberValueKey(true)).toBe('yes');
    expect(newMemberValueKey(false)).toBe('no');
    expect(newMemberAnnounceKey(true)).toBe('new_member_yes');
    expect(newMemberAnnounceKey(false)).toBe('new_member_no');
  });

  it('resolves every new label in en, es and ca', () => {
    const keys = ['label_new_member', 'new_member_badge', 'new_member_yes', 'new_member_no', 'yes', 'no'];
    for (const code of LOCALE_CODES) {
      const members = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8')).members as Record<string, unknown>;
      for (const key of keys) {
        expect(typeof members[key], `members.${key} missing from ${code}.json`).toBe('string');
      }
    }
  });

  it('announces the value rather than leaving a bare "Yes" to a screen reader', () => {
    // #960 — the chip's own text is one word, and the label beside it is not
    // programmatically tied to it, so the full sentence is the accessible name.
    expect(layoutSrc).toContain('aria-label={announce}');
    for (const [name, src] of [['expanded row', expandedSrc], ['Edit form', editFormSrc]] as const) {
      expect(src, `${name} does not announce the value`).toContain('newMemberAnnounceKey(');
      expect(src).toContain('newMemberValueKey(');
    }
  });
});
