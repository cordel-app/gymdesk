import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Regression test for #900 — the `Expired` Promotion status on the Promotions
// page.
//
// `Expired` is written by the scheduled sweep (POST /promotion-lifecycle/run),
// never chosen by a gym: it means "this Promotion reached its End Date", and
// offering it in the form would turn it into a second way of saying Inactive
// (§1, §4). So the page has two status lists, not one — the filter offers all
// three (§10: an expired Promotion must be findable and must not be lumped in
// with the inactive ones) and the editor offers the two a gym decides between —
// and an expired row still has to *display* its status in the form, or saving
// its other fields would quietly reactivate it.
//
// This repo has no component-test infra for apps/admin (see docs/architecture.md's
// TL;DR), so — like promotions-section-editing.test.ts (#627) — this pins the
// structure down by scanning the page source and the locale files.

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const PAGE = join(__dirname, '..', 'app', '[locale]', 'promotions', 'page.tsx');
const STATUS_BADGE = join(__dirname, '..', 'components', 'StatusBadge.tsx');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const pageSrc = stripComments(readFileSync(PAGE, 'utf-8'));

describe('#900 the filter and the editor offer different status sets', () => {
  it('the filter list carries expired', () => {
    expect(pageSrc).toMatch(
      /LIFECYCLE_FILTER_STATUSES[^=]*=\s*\[\s*'active',\s*'inactive',\s*'expired'\s*\]/,
    );
  });

  it('the editor list does not', () => {
    const match = pageSrc.match(/LIFECYCLE_EDIT_STATUSES[^=]*=\s*\[([^\]]*)\]/);
    expect(match, 'the page must declare LIFECYCLE_EDIT_STATUSES').not.toBeNull();
    expect(match![1]).not.toContain('expired');
    expect(match![1]).toContain("'active'");
    expect(match![1]).toContain("'inactive'");
  });

  it('the status filter is built from the filter list', () => {
    expect(pageSrc).toContain('options={LIFECYCLE_FILTER_STATUSES.map(');
  });

  it('the status <select> is built from the editor list', () => {
    expect(pageSrc).toContain('{LIFECYCLE_EDIT_STATUSES.map(');
  });

  it('neither list is the single LIFECYCLE_STATUSES the page used to have', () => {
    expect(pageSrc).not.toMatch(/\bLIFECYCLE_STATUSES\b/);
  });
});

describe('#900 an expired Promotion still shows its status in the form', () => {
  it('renders the held value as a disabled option when it is not selectable', () => {
    expect(pageSrc).toContain('!LIFECYCLE_EDIT_STATUSES.includes(editForm.lifecycle_status)');
    expect(pageSrc).toMatch(/<option value=\{editForm\.lifecycle_status\} disabled>/);
  });

  it('types the row and the form value as the three-status union', () => {
    expect(pageSrc).toMatch(
      /type PromotionLifecycleStatus = 'active' \| 'inactive' \| 'expired';/,
    );
    expect(pageSrc).toContain('lifecycle_status: PromotionLifecycleStatus;');
    expect(pageSrc, 'no leftover two-status cast').not.toMatch(/as 'active' \| 'inactive'/);
  });
});

describe('#900 the status label and badge are the existing shared ones', () => {
  it('every label comes from the shared status namespace, never a literal', () => {
    expect(pageSrc).toContain('tStatus(editForm.lifecycle_status)');
    expect(pageSrc, 'the page must not hardcode the word').not.toMatch(/['"`]Expired['"`]/);
  });

  it('status.expired is translated in every locale', () => {
    for (const code of LOCALE_CODES) {
      const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
      expect(messages.status?.expired, `status.expired missing in ${code}`).toBeTruthy();
    }
  });

  it('StatusBadge already distinguishes expired from active and inactive (§9)', () => {
    const badge = readFileSync(STATUS_BADGE, 'utf-8');
    const colourOf = (status: string) =>
      badge.match(new RegExp(`${status}:\\s*\\{[^}]*\\}`))?.[0];
    expect(colourOf('expired')).toBeTruthy();
    expect(colourOf('expired')).not.toBe(colourOf('inactive'));
    expect(colourOf('expired')).not.toBe(colourOf('active'));
  });
});
