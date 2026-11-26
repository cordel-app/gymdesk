import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

// #3467: the member-facing Notes sit in General, right below Status, under
// "Notes for member", on both Workout Templates screens, and nowhere else.
const root = path.resolve(__dirname, '..', '..');
const gymSrc = readFileSync(path.join(root, 'src/app/[locale]/workout-templates/page.tsx'), 'utf8');
const baseSrc = readFileSync(path.join(root, 'src/app/[locale]/cordel/workout-templates/page.tsx'), 'utf8');
const locale = (l: string) => JSON.parse(readFileSync(path.join(root, `locales/base/${l}.json`), 'utf8')).workout_templates;

function after(src: string, first: string, second: string): boolean {
  const i = src.indexOf(first);
  return i >= 0 && src.indexOf(second, i) > i;
}

describe('Workout Templates: Notes for member (#3467)', () => {
  it('labels the field "Notes for member" in every language and drops the old section label', () => {
    expect(locale('en').label_notes_for_member).toBe('Notes for member');
    for (const l of ['en', 'es', 'ca']) {
      expect(locale(l).label_notes_for_member).toBeTruthy();
      expect(locale(l).section_notes).toBeUndefined();
    }
  });

  it('places the field right after Status in both halves of the gym card', () => {
    expect(gymSrc).not.toContain("t('section_notes')");
    // Edit: the Status select, then the notes textarea, then Description.
    const edit = gymSrc.slice(gymSrc.indexOf('{/* Inline edit form */}'), gymSrc.indexOf('{/* Read-only expanded sections */}'));
    expect(after(edit, "t('label_status')", "t('label_notes_for_member')")).toBe(true);
    expect(after(edit, "t('label_notes_for_member')", 'editForm.notes')).toBe(true);
    // Read-only: the Status row, then the notes row, both in General.
    const ro = gymSrc.slice(gymSrc.indexOf('{/* Read-only expanded sections */}'));
    const general = ro.slice(0, ro.indexOf("t('section_workout_structure')"));
    expect(after(general, "label={t('label_status')}", "label={t('label_notes_for_member')}")).toBe(true);
  });

  it('edits the same notes field on Base Workout Templates, below Status', () => {
    expect(after(baseSrc, "t('label_status')", "t('label_notes_for_member')")).toBe(true);
    expect(baseSrc).toContain('notes: f.notes.trim() || null');
    expect(baseSrc).toContain("notes: tpl.notes ?? ''");
  });
});
