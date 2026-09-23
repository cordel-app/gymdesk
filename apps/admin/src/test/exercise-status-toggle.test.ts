import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Regression test for #673 — the Exercise context menu carries a status toggle:
// Deactivate on an active exercise, Activate on an inactive one.
//
// The toggle reuses PUT /exercises/:id with a status-only body (the API side is
// covered by api/src/test/exercises.test.ts), so what matters here is the menu
// wiring: the label follows the row's current status, the call sends nothing but
// the status, and the write gate and the base-exercise menu are unchanged.
//
// This repo has no component-test infra for apps/admin (see docs/architecture.md's
// TL;DR), so — like sellable-items-price-label.test.ts (#670) — this scans the
// page source and the locale files.

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const PAGE_PATH = join(__dirname, '..', 'app', '[locale]', 'exercises', 'page.tsx');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

type Messages = Record<string, unknown>;

function exercisesKey(messages: Messages, key: string): string | undefined {
  const ns = messages['exercises'];
  if (ns == null || typeof ns !== 'object') return undefined;
  const value = (ns as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

// The source comments name #673 and both labels, so the scans run comment-free.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const locales = Object.fromEntries(
  LOCALE_CODES.map((c) => [
    c,
    JSON.parse(readFileSync(join(LOCALES_DIR, `${c}.json`), 'utf-8')) as Messages,
  ]),
) as Record<(typeof LOCALE_CODES)[number], Messages>;

const EXPECTED: Record<(typeof LOCALE_CODES)[number], { activate: string; deactivate: string }> = {
  en: { activate: 'Activate', deactivate: 'Deactivate' },
  es: { activate: 'Activar', deactivate: 'Desactivar' },
  ca: { activate: 'Activar', deactivate: 'Desactivar' },
};

const source = stripComments(readFileSync(PAGE_PATH, 'utf-8'));

/** The `menuItems` assignment in renderRow: base-exercise branch, then the gym one. */
function menuItemsBlock(): string {
  const start = source.indexOf('const menuItems');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('return (', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('Exercises: Activate/Deactivate in the context menu (#673)', () => {
  it.each(LOCALE_CODES)('has both menu labels in %s.json', (code) => {
    expect(exercisesKey(locales[code], 'activate')).toBe(EXPECTED[code].activate);
    expect(exercisesKey(locales[code], 'deactivate')).toBe(EXPECTED[code].deactivate);
  });

  it('shows Deactivate for an active exercise and Activate for an inactive one', () => {
    const block = menuItemsBlock();
    const toggle = block.match(
      /ex\.status === 'active'\s*\?\s*\{[^}]*label: t\('deactivate'\)[^}]*\}\s*:\s*\{[^}]*label: t\('activate'\)[^}]*\}/,
    );
    expect(toggle).not.toBeNull();
    expect(toggle![0]).toContain('handleToggleStatus(ex)');
  });

  it('gates the toggle on write access, like the other write actions', () => {
    const block = menuItemsBlock();
    const entries = block.match(/label: t\('(?:de)?activate'\)[^}]*/g) ?? [];
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry).toContain('disabled: !canWrite');
      expect(entry).toContain('title: readOnlyTitle');
    }
  });

  it('leaves the base-exercise menu at Details + Clone', () => {
    const block = menuItemsBlock();
    const baseBranch = block.slice(0, block.indexOf(': ['));
    expect(baseBranch).toContain("t('details')");
    expect(baseBranch).toContain("t('clone')");
    expect(baseBranch).not.toContain('activate');
  });

  it('sends a status-only PUT and flips to the opposite status', () => {
    const start = source.indexOf('async function handleToggleStatus');
    expect(start).toBeGreaterThan(-1);
    const fn = source.slice(start, source.indexOf('\n  }', start));
    expect(fn).toContain("const next = ex.status === 'active' ? 'inactive' : 'active'");
    expect(fn).toContain('method: \'PUT\'');
    expect(fn).toContain('JSON.stringify({ status: next })');
    // The list must re-render from the server so the status badge follows.
    expect(fn).toContain('load()');
  });

  it('keeps an open inline editor in sync so saving it cannot revert the toggle', () => {
    const start = source.indexOf('async function handleToggleStatus');
    const fn = source.slice(start, source.indexOf('\n  }', start));
    expect(fn).toContain('if (editingId === ex.id) setEditForm');
    expect(fn).toContain('status: next');
  });

  it('does not add a confirmation dialog for the toggle', () => {
    // §"No confirmation modal is required" — the only ConfirmDialog stays the delete one.
    expect(source.match(/<ConfirmDialog/g) ?? []).toHaveLength(1);
    expect(source).toContain("message={t('confirm_delete')}");
  });
});
