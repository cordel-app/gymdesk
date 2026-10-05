import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #1029 — an Activity's schedule reads until `⋮ → Edit`, and then it is
// directly editable: no per-rule `Edit` button, a `✕` at the far right of each
// row, and `+ Add schedule rule` only inside the mode.
//
// This repo has no component-test infra for apps/admin (docs/architecture.md's
// TL;DR), so — like class-session-detail-edit.test.ts (#980 stage 1) — the
// structure is pinned by scanning the page source and the locale files. What is
// worth pinning is the half of the ticket that is a *rule* rather than markup:
// one `editing` flag decides both halves of the section, every control is
// absent outside it, and leaving the mode leaves no editing state behind.

const PAGE_PATH = join(__dirname, '..', 'app', '[locale]', 'activity-types', 'page.tsx');
const CHROME_PATH = join(__dirname, '..', 'components', 'formChrome.ts');
const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const pageSrc = stripComments(readFileSync(PAGE_PATH, 'utf-8'));
const chromeSrc = readFileSync(CHROME_PATH, 'utf-8');

const locales = Object.fromEntries(
  LOCALE_CODES.map((c) => [c, JSON.parse(readFileSync(join(LOCALES_DIR, `${c}.json`), 'utf-8'))]),
) as Record<(typeof LOCALE_CODES)[number], any>;

/** The section's body — everything the `editing` flag governs. */
const sectionSrc = (() => {
  const start = pageSrc.indexOf('function renderScheduleSection(');
  const end = pageSrc.indexOf('function renderRow(');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return pageSrc.slice(start, end);
})();

describe('Activity schedule: editing behind the Activity\'s own Edit mode (#1029)', () => {
  it('takes the mode as its one flag, and both halves of the card pass it', () => {
    expect(pageSrc).toContain('function renderScheduleSection(row: ActivityType, editing: boolean)');
    // The edit body and the read-only body each render the same section, so a
    // rule cannot be shown in one and missing from the other.
    expect(pageSrc).toContain('{renderScheduleSection(row, true)}');
    expect(pageSrc).toContain('{renderScheduleSection(row, false)}');
    expect(pageSrc).not.toContain('renderScheduleSection(row)');
  });

  it('has no per-rule Edit button left, in the page or the locales', () => {
    expect(pageSrc).not.toContain("ts('edit_rule')");
    for (const code of LOCALE_CODES) {
      expect(locales[code].activity_types.schedule.edit_rule).toBeUndefined();
    }
  });

  it('opens the existing rule editor from the row itself, only in Edit mode', () => {
    // The row *is* the affordance, so there is exactly one caller of the
    // editor-opening handler and it sits inside the `editing ?` branch.
    expect((sectionSrc.match(/openEditRule\(/g) ?? []).length).toBe(1);
    const rowBranch = sectionSrc.slice(sectionSrc.indexOf('{editing ? ('));
    expect(rowBranch).toContain('onClick={() => openEditRule(rule)}');
    // …and it is a real button, so the editor is reachable from the keyboard.
    expect(rowBranch).toMatch(/<button\s+type="button"\s+onClick=\{\(\) => openEditRule\(rule\)\}/);
  });

  it('renders the delete action as a ✕ gated on the mode, never a Delete button', () => {
    expect(sectionSrc).toContain('{editing && (');
    const deleteBtn = sectionSrc.match(/<button[\s\S]*?deleteRule\(row\.id, rule\.id\)[\s\S]*?<\/button>/)?.[0] ?? '';
    expect(deleteBtn).toContain('>✕</button>');
    expect(deleteBtn).toContain('style={rowRemoveBtnStyle}');
    // The glyph carries the row's action as its accessible name.
    expect(deleteBtn).toContain("aria-label={ts('delete_rule')}");
    for (const code of LOCALE_CODES) {
      expect(locales[code].activity_types.schedule.delete_rule.length).toBeGreaterThan('Delete'.length);
    }
    // Deletion keeps the route and the #482 booked-occurrence confirmation it
    // always had — this ticket changed the affordance, not the behaviour.
    expect(pageSrc).toContain("?confirm_cancel_booked=true");
    expect(pageSrc).toContain('deleteRuleConflict');
  });

  it('offers + Add schedule rule only inside the mode, in the app\'s own theme', () => {
    expect(sectionSrc).toContain('editing && editingRuleId == null && (');
    const addBtn = sectionSrc.match(/<button[\s\S]*?openAddRule\(row\.id\)[\s\S]*?<\/button>/)?.[0] ?? '';
    expect(addBtn).toContain('style={dashedAddBtnStyle}');
    // The lilac text link it replaced followed no Theme setting (#912/#954).
    expect(sectionSrc).not.toContain('#6c63ff');
    expect(chromeSrc).toContain('export const dashedAddBtnStyle');
  });

  it('declares the row ✕ once, as card chrome rather than per page (#929)', () => {
    expect(chromeSrc).toContain('export const rowRemoveBtnStyle');
    // No page may respell it beside the shared one.
    expect(sectionSrc).not.toContain("color: '#c0392b'");
  });

  it('leaves no schedule editing state behind when the mode closes', () => {
    const reset = pageSrc.match(/function resetScheduleEditing\(\)[\s\S]*?\n {2}\}/)?.[0] ?? '';
    for (const setter of [
      'setAddingRuleFor(null)', 'setEditingRuleId(null)', 'setRuleError(null)',
      'setEditRuleConflict(null)', 'setDeleteRuleConflict(null)',
    ]) {
      expect(reset).toContain(setter);
    }
    // Entering, cancelling, saving and deleting the Activity all go through it.
    const cancel = pageSrc.match(/function cancelEdit\(\)[\s\S]*?\n {2}\}/)?.[0] ?? '';
    expect(cancel).toContain('resetScheduleEditing()');
    const open = pageSrc.match(/async function openEdit\(row: ActivityType\)[\s\S]*?setEditError\(null\);/)?.[0] ?? '';
    expect(open).toContain('resetScheduleEditing()');
    const save = pageSrc.match(/async function handleSave\([\s\S]*?\n {2}\}/)?.[0] ?? '';
    expect(save).toContain('resetScheduleEditing()');
  });
});
