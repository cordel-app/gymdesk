import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { MEMBER_PROFILE_FIELDS, newMemberValueKey } from '../app/[locale]/members/memberProfile';
import {
  newMemberChipStyle,
  profileInlineCellStyle,
  profileInlineFieldLabelStyle,
} from '../app/[locale]/members/MemberProfileLayout';
import { listNameBadgeAccentStyle, listNameBadgeStyle } from '../components/listChrome';
import { formFieldLabelStyle } from '../components/formChrome';

// Regression tests for #960 — the Profile's `New Member` value is a compact
// Yes/No chip on the label's own row, not a checkbox glyph on a row of its own.
//
// This repo has no component-test infra for apps/admin (see docs/architecture.md's
// TL;DR), so the structural assertions scan the source the way
// member-new-member-status.test.ts (#927) does, and the shared styles and the
// pure helpers are exercised directly.

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
const profileSrc = read('memberProfile.ts');

describe('Members: New Member is a chip, not a checkbox (#960)', () => {
  it('has no checkbox glyph left anywhere in the Profile', () => {
    // ☑ / ☐ — #927's value, which cost a whole row of card height.
    for (const [name, src] of [
      ['layout', layoutSrc], ['declaration', profileSrc],
      ['expanded row', expandedSrc], ['Edit form', editFormSrc],
    ] as const) {
      for (const glyph of ['☑', '☐', 'newMemberCheckbox']) {
        expect(src, `${name} still draws the New Member checkbox`).not.toContain(glyph);
      }
    }
  });

  it('renders the value as a chip and nothing interactive', () => {
    const cell = layoutSrc.slice(layoutSrc.indexOf('export function NewMemberValue'));
    expect(cell).toContain('newMemberChipStyle(isNewMember)');
    for (const control of ['<input', '<button', 'onChange', 'onClick', 'disabled']) {
      expect(cell, `the New Member chip must stay read-only, found ${control}`).not.toContain(control);
    }
  });

  it('reads Yes or No from the one declaration', () => {
    expect(newMemberValueKey(true)).toBe('yes');
    expect(newMemberValueKey(false)).toBe('no');
    for (const [name, src] of [['expanded row', expandedSrc], ['Edit form', editFormSrc]] as const) {
      expect(src, `${name} picks its own wording`).toContain('newMemberValueKey(');
    }
  });

  it('resolves the chip labels in en, es and ca', () => {
    for (const code of LOCALE_CODES) {
      const members = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8')).members as Record<string, unknown>;
      for (const key of ['yes', 'no']) {
        expect(typeof members[key], `members.${key} missing from ${code}.json`).toBe('string');
      }
    }
  });
});

describe('Members: the chip borrows the list pill, declaring no colour (#960)', () => {
  it('is the accent pill when the member is new and the neutral one when not', () => {
    expect(newMemberChipStyle(true).background).toBe(listNameBadgeAccentStyle.background);
    expect(newMemberChipStyle(true).color).toBe(listNameBadgeAccentStyle.color);
    expect(newMemberChipStyle(false).background).toBe(listNameBadgeStyle.background);
    expect(newMemberChipStyle(false).color).toBe(listNameBadgeStyle.color);
  });

  it('keeps the pill\'s own sizing, type and radius', () => {
    for (const isNew of [true, false]) {
      const chip = newMemberChipStyle(isNew);
      expect(chip.fontSize).toBe(listNameBadgeStyle.fontSize);
      expect(chip.borderRadius).toBe(listNameBadgeStyle.borderRadius);
      expect(chip.padding).toBe(listNameBadgeStyle.padding);
      // The pill's left margin belongs to the name cell it was written for; the
      // inline row supplies the gap instead.
      expect(chip.marginLeft).toBe(0);
    }
  });

  it('declares no colour of its own, in the layout or in either half', () => {
    const hex = /#[0-9a-fA-F]{3,8}\b/;
    const cell = layoutSrc.slice(layoutSrc.indexOf('export function NewMemberValue'));
    expect(cell).not.toMatch(hex);
    expect(layoutSrc).toContain("from '@/components/listChrome'");
  });
});

describe('Members: label and chip share one row (#960)', () => {
  it('lays a calculated field out inline, in the shared layout', () => {
    expect(layoutSrc).toContain('profileInlineCellStyle');
    expect(profileInlineCellStyle.display).toBe('flex');
    expect(profileInlineCellStyle.alignItems).toBe('center');
    // The stacked label-above-control shape is the editable field's, because
    // that is the box its `<input>` occupies in the other mode (#929).
    expect(layoutSrc).toContain('field.calculated ? (');
    expect(layoutSrc).toContain('renderField(field as MemberEditableFieldSpec)');
  });

  it('keeps the Profile\'s own label type and drops only the stacked margin', () => {
    expect(profileInlineFieldLabelStyle.fontSize).toBe(formFieldLabelStyle.fontSize);
    expect(profileInlineFieldLabelStyle.fontWeight).toBe(formFieldLabelStyle.fontWeight);
    expect(profileInlineFieldLabelStyle.color).toBe(formFieldLabelStyle.color);
    expect(profileInlineFieldLabelStyle.marginBottom).toBe(0);
  });

  it('is still the one field set, placed once, in both modes', () => {
    expect(MEMBER_PROFILE_FIELDS.find((f) => f.key === 'new_member')!.calculated).toBe(true);
    expect(layoutSrc.match(/MEMBER_PROFILE_FIELDS\.map/g)?.length).toBe(1);
    for (const [name, src] of [['expanded row', expandedSrc], ['Edit form', editFormSrc]] as const) {
      expect(src, `${name} lays the chip out itself`).not.toContain('profileInlineCellStyle');
      expect(src).toContain('renderCalculated=');
    }
  });
});
