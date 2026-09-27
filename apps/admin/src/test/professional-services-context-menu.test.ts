import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #802 — the Professional Services context menu (⋮) orders its actions
// Duplicate → Deactivate → … → Details, and Deactivate carries the shared
// destructive style.
//
// The ticket describes the menu it saw as "Details / Deactivate / Duplicate",
// which is exactly what a **System** professional service renders, since Edit and
// Delete are hidden for those rows. So the three named actions are pinned to
// fixed positions — Duplicate first, Deactivate second, Details last — and Edit
// and Delete keep their existing behaviour in the slots between them. For a
// System row that collapses to exactly Duplicate / Deactivate / Details.
//
// The styling reuses ContextMenu's own `danger` flag (the red `#c0392b` that
// Delete already uses) rather than a per-page colour, per §4 and §8. Activate
// occupies the same slot but is not destructive, so it stays unstyled.
//
// This is a source scan: apps/admin has no component-test harness, so the page
// is parsed as text in the same style as included-services-removed.test.ts.

const PAGE = join(__dirname, '..', 'app', '[locale]', 'professional-services', 'page.tsx');
const CONTEXT_MENU = join(__dirname, '..', 'components', 'ContextMenu.tsx');
const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

/** The page's own comments name the actions and the ticket, so scans run stripped. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const pageSrc = readFileSync(PAGE, 'utf-8');
const page = stripComments(pageSrc);
const contextMenuSrc = readFileSync(CONTEXT_MENU, 'utf-8');

/** The `menuItems: ContextMenuItem[] = [ … ];` literal, comments stripped. */
function menuItemsBlock(): string {
  const start = page.indexOf('const menuItems: ContextMenuItem[] = [');
  expect(start, 'the page declares a menuItems array').toBeGreaterThan(-1);
  const end = page.indexOf('];', start);
  expect(end, 'the menuItems array is closed').toBeGreaterThan(start);
  return page.slice(start, end + 2);
}

/** Positions of each `t('<key>')` label inside the menu literal, in source order. */
function labelOrder(block: string): string[] {
  return [...block.matchAll(/label:\s*t\('([a-z_]+)'\)/g)].map((m) => m[1]);
}

const block = menuItemsBlock();
const order = labelOrder(block);

describe('#802 Professional Services context menu — ordering', () => {
  it('declares exactly the five existing actions, and no new one', () => {
    expect([...order].sort()).toEqual(
      ['activate', 'deactivate', 'delete', 'details', 'duplicate', 'edit'].sort(),
    );
  });

  it('puts Duplicate first', () => {
    expect(order[0]).toBe('duplicate');
  });

  it('puts the Deactivate / Activate pair second', () => {
    // The two share one slot through a ternary on item.status.
    expect(order[1]).toBe('deactivate');
    expect(order[2]).toBe('activate');
  });

  it('puts Details last', () => {
    expect(order[order.length - 1]).toBe('details');
  });

  it('keeps Edit and Delete between the two fixed ends', () => {
    const editAt = order.indexOf('edit');
    const deleteAt = order.indexOf('delete');
    for (const at of [editAt, deleteAt]) {
      expect(at).toBeGreaterThan(order.indexOf('activate'));
      expect(at).toBeLessThan(order.indexOf('details'));
    }
    expect(editAt).toBeLessThan(deleteAt);
  });

  it('leaves a System professional service with exactly Duplicate / Deactivate / Details', () => {
    // Edit and Delete are the only two gated on !isSystem, so dropping them is
    // what a System row renders.
    const systemGated = [...block.matchAll(/\.\.\.\(!isSystem \? \[\{ label: t\('([a-z_]+)'\)/g)]
      .map((m) => m[1]);
    expect(systemGated.sort()).toEqual(['delete', 'edit']);
    expect(order.filter((k) => !systemGated.includes(k) && k !== 'activate'))
      .toEqual(['duplicate', 'deactivate', 'details']);
  });
});

describe('#802 Professional Services context menu — destructive styling', () => {
  it('marks Deactivate as danger', () => {
    expect(block).toMatch(/label: t\('deactivate'\)[^}]*danger: true/);
  });

  it('does not mark Activate as danger', () => {
    const activate = block.slice(block.indexOf("t('activate')"));
    const item = activate.slice(0, activate.indexOf('}'));
    expect(item).not.toContain('danger');
  });

  it('keeps Delete marked as danger, and marks nothing else', () => {
    expect(block).toMatch(/label: t\('delete'\)[^}]*danger: true/);
    expect((block.match(/danger: true/g) ?? []).length).toBe(2);
    for (const key of ['duplicate', 'edit', 'details']) {
      const from = block.slice(block.indexOf(`t('${key}')`));
      expect(from.slice(0, from.indexOf('}'))).not.toContain('danger');
    }
  });

  it('reuses the shared destructive colour instead of hard-coding one in the page', () => {
    // #c0392b lives in ContextMenu, driven by the `danger` flag (§4, §8). The
    // page's own error-text colour is unrelated, so the scan is scoped to the
    // menu literal and to the `<ContextMenu … />` usage.
    expect(contextMenuSrc).toContain("item.danger ? '#c0392b'");
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,6}|color:|style:/);
    const usage = page.slice(page.indexOf('<ContextMenu items={menuItems}'));
    expect(usage.slice(0, usage.indexOf('/>'))).not.toMatch(/#[0-9a-fA-F]{3,6}|style=/);
  });

  it('does not communicate the action by colour alone', () => {
    // The label is a real translated string and the item stays a role="menuitem"
    // button, so colour is decoration on top of both (§9).
    expect(block).toContain("label: t('deactivate')");
    expect(contextMenuSrc).toContain('role="menuitem"');
  });
});

describe('#802 Professional Services context menu — behaviour is unchanged', () => {
  it('keeps each action wired to the same handler', () => {
    expect(block).toMatch(/t\('duplicate'\), onClick: \(\) => handleDuplicate\(item\)/);
    expect(block).toMatch(/t\('deactivate'\), onClick: \(\) => handleDeactivate\(item\)/);
    expect(block).toMatch(/t\('activate'\), onClick: \(\) => handleActivate\(item\)/);
    expect(block).toMatch(/t\('edit'\), onClick: \(\) => openEdit\(item\)/);
    expect(block).toMatch(/t\('delete'\), onClick: \(\) => setDeleting\(item\)/);
    expect(block).toMatch(/t\('details'\), onClick: \(\) => setDetails\(item\)/);
  });

  it('keeps each write action gated on canWrite with the read-only tooltip', () => {
    for (const key of ['duplicate', 'deactivate', 'activate', 'edit', 'delete']) {
      const from = block.slice(block.indexOf(`t('${key}')`));
      const item = from.slice(0, from.indexOf('}'));
      expect(item, `${key} stays gated`).toContain('disabled: !canWrite');
      expect(item, `${key} keeps its tooltip`).toContain('title: readOnlyTitle');
    }
  });

  it('leaves Details ungated, as a read action', () => {
    const from = block.slice(block.indexOf("t('details')"));
    expect(from.slice(0, from.indexOf('}'))).not.toContain('canWrite');
  });

  it('calls the same endpoints', () => {
    expect(page).toContain('/duplicate`, { method: \'POST\' }');
    expect(page).toContain('/deactivate`, { method: \'POST\' }');
    expect(page).toContain('/activate`, { method: \'POST\' }');
  });

  it('still opens the existing Details modal, with its View Audit Log button', () => {
    expect(page).toContain('open={details !== null}');
    expect(page).toContain('entityType="professional_service"');
  });

  it('uses the shared ContextMenu rather than a page-local menu', () => {
    expect(pageSrc).toMatch(/import \{[^}]*ContextMenu[^}]*\} from '.*ContextMenu'/);
    expect(page).toContain('<ContextMenu items={menuItems}');
    expect(page).not.toContain('role="menu"');
  });
});

describe('#802 Professional Services context menu — labels', () => {
  it('keeps every action label in all three locales', () => {
    for (const code of LOCALE_CODES) {
      const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
      const ns = messages['professional_services'] as Record<string, unknown>;
      for (const key of ['duplicate', 'deactivate', 'activate', 'edit', 'delete', 'details']) {
        expect(typeof ns[key], `${code}.professional_services.${key}`).toBe('string');
        expect((ns[key] as string).length).toBeGreaterThan(0);
      }
    }
  });
});
