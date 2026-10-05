import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import {
  formActionsRowStyle,
  inlineActionsRowStyle,
  modalActionsRowStyle,
} from '@/components/formChrome';

// #1028 — a form's Cancel/Save pair is left-aligned, from one of the three rows
// `formChrome.ts` declares, and a page no longer spells that layout itself.
//
// Before this ticket the app answered the question three ways at once: the
// shared card-level row sat at `justifyContent: 'flex-end'`, the shared
// section-level row was left-aligned, and roughly thirty entity forms declared
// a `{ display: 'flex', gap: 8, justifyContent: 'flex-end' }` of their own — so
// Spaces' `[Cancel] [Save changes]` ended up at the far right of a card whose
// fields start at the content margin, Products' pair at the left, and Staff's
// read `[Save] [Cancel]`.
//
// `apps/admin` has no component-test infra (docs/architecture.md's TL;DR), so
// the shared styles are asserted directly and the sweep is pinned by scanning
// the sources — exactly as #912/#954/#968's own tests do.

const SRC = join(__dirname, '..');

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'test' || entry === 'node_modules') continue;
      walk(full, out);
    } else if (entry.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

const SOURCES = walk(SRC).map((path) => ({
  path: relative(SRC, path),
  src: stripComments(readFileSync(path, 'utf-8')),
}));

const read = (...parts: string[]) => stripComments(readFileSync(join(SRC, ...parts), 'utf-8'));

describe('The three shared action rows all left-align (#1028)', () => {
  it('declares no justification on any of them', () => {
    // Flex's own default is `flex-start`, so the absence of the property *is*
    // the rule: there is no second value a row could be set to by accident.
    expect(formActionsRowStyle.justifyContent).toBeUndefined();
    expect(inlineActionsRowStyle.justifyContent).toBeUndefined();
    expect(modalActionsRowStyle.justifyContent).toBeUndefined();
    for (const row of [formActionsRowStyle, inlineActionsRowStyle, modalActionsRowStyle]) {
      expect(row.display).toBe('flex');
    }
  });

  it('keeps each row at the fields\' own content margin', () => {
    // No inset of its own in any of the three: the pair lines up with the
    // controls above it rather than with the card's edge.
    for (const row of [formActionsRowStyle, inlineActionsRowStyle, modalActionsRowStyle]) {
      expect(row.marginLeft).toBeUndefined();
      expect(row.paddingLeft).toBeUndefined();
    }
  });

  it('keeps what distinguishes them: the hairline, and the spacing', () => {
    // The card-level row is the only one that separates itself from the fields
    // above with a rule, and it is the card's own themed border (#929).
    expect(formActionsRowStyle.borderTop).toBe('1px solid var(--gd-card-border, #ececf0)');
    expect(inlineActionsRowStyle.borderTop).toBeUndefined();
    expect(modalActionsRowStyle.borderTop).toBeUndefined();
    // And the dialog row carries the modal's own spacing.
    expect(modalActionsRowStyle.gap).toBe(10);
    expect(modalActionsRowStyle.marginTop).toBe(24);
  });
});

describe('No entity form declares its own right-aligned pair (#1028)', () => {
  it('leaves no entity form spelling a right-aligned pair of its own', () => {
    // A `justifyContent: 'flex-end'` within two lines of a Cancel or a Save
    // button is the shape this ticket removed. Pagination rows, a `⋮ → Details`
    // view's `Close` and a card's `⋮` cell are not form actions, so the scan is
    // anchored on the buttons rather than on the property alone.
    //
    // Exactly three files are left, and the gate asserts the *set* rather than
    // consulting an allowlist — a fourth one fails the build. All three are
    // dialogs that are not entity forms: `ConfirmDialog` and
    // `DependencyDialog` are a destructive confirmation's `Cancel`/`Delete`
    // pair, and `CrudModal`'s is its `hideSave` branch, which is how that
    // component renders a read-only Details view whose single `Close` keeps the
    // convention every standalone Details modal in the app already uses.
    const offenders: string[] = [];
    for (const { path, src } of SOURCES) {
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        if (!line.includes("justifyContent: 'flex-end'")) return;
        const window = lines.slice(i + 1, i + 3).join('\n');
        if (/onClick=\{(cancelEdit|cancelInlineNew|onCancel|handleSave|onSave|saveInlineNew)\b/.test(window)) {
          offenders.push(path);
        }
      });
    }
    expect(offenders.sort()).toEqual([
      'components/ConfirmDialog.tsx',
      'components/CrudModal.tsx',
      'components/DependencyDialog.tsx',
    ]);
  });

  it('routes the Spaces form — the one in the ticket — through the shared row', () => {
    const spaces = read('app', '[locale]', 'spaces', 'page.tsx');
    expect(spaces).toMatch(/import \{[^}]*\binlineActionsRowStyle\b[^}]*\} from '@\/components\/formChrome'/);
    // Both halves: the inline `+ Add Space` form and the inline editor.
    expect(spaces).toContain('<div style={inlineActionsRowStyle}>');
    expect(spaces).toContain('<div style={{ ...inlineActionsRowStyle, marginTop: 16 }}>');
    // The labels are untouched — this ticket is layout, not terminology.
    expect(spaces).toContain("{t('cancel')}");
    expect(spaces).toContain("{inlineNew.saving ? t('saving') : t('save_changes')}");
  });

  it('puts Staff\'s pair in the app\'s own Cancel → Save order', () => {
    // It was the one form that read `[Save] [Cancel]`.
    const staff = read('app', '[locale]', 'staff', 'page.tsx');
    expect(staff).toMatch(
      /\.\.\.inlineActionsRowStyle, marginTop: 20 \}\}>\s*<button onClick=\{cancelEdit\}[\s\S]*?onClick=\{handleSave\}/,
    );
  });

  it('drops the Assigned Plan section editor\'s right-align override', () => {
    const configuration = read('components', 'assignedPlan', 'AssignedPlanConfiguration.tsx');
    expect(configuration).toContain('<div style={inlineActionsRowStyle}>');
    expect(configuration).not.toContain("justifyContent: 'flex-end'");
  });
});

describe('The Modal CRUD shape follows the same rule (#1028)', () => {
  const crud = read('components', 'CrudModal.tsx');

  it('takes the shared dialog row for a form', () => {
    expect(crud).toMatch(/import \{[^}]*\bmodalActionsRowStyle\b[^}]*\} from '\.\/formChrome'/);
    expect(crud).toContain(
      "<div style={hideSave ? { ...modalActionsRowStyle, justifyContent: 'flex-end' } : modalActionsRowStyle}>",
    );
  });

  it('keeps the order inside the row, extraFooter first', () => {
    expect(crud).toMatch(/\{extraFooter\}\s*<button onClick=\{onCancel\}[\s\S]*?\{!hideSave && <button onClick=\{onSave\}/);
  });
});
