import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  LEGACY_FREQUENCIES,
  OFFERED_FREQUENCIES,
  frequencyOptions,
  isLegacyFrequency,
} from '@/app/[locale]/financials/sellable-items/sellableItemFrequency';

// #821 — a Sellable Item's Billing Frequency dropdown offers five choices.
//
//   Before:  — / Once / Per Session / 4 Weeks / Week / Month / Year
//   After:   — / Once / Per Session / 4 Weeks / Month / Year
//
// `week` is not deleted from the data: an item configured before the ticket
// still stores it, still bills on it and still classifies as a periodical
// benefit. The API is what enforces the rule (`api/src/domain/sellableItemFrequency.ts`,
// exercised by `gym-charges.test.ts`); this file covers the declaration and the
// two places the page renders it — the inline create card and the inline editor,
// which must render the same list (#805).
//
// apps/admin has no component-test infra (docs/architecture.md's TL;DR), so the
// page is pinned by scanning its source the way plan-billing-frequency.test.ts
// does, while the declaration's pure parts are exercised directly.

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const PAGE = join(__dirname, '..', 'app', '[locale]', 'financials', 'sellable-items', 'page.tsx');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const pageSrc = stripComments(readFileSync(PAGE, 'utf-8'));

function sellableItemsNamespace(code: string): Record<string, string> {
  const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
  return (messages.sellable_items ?? {}) as Record<string, string>;
}

describe('the declaration', () => {
  it('offers exactly the five choices the ticket lists, in that order', () => {
    expect(OFFERED_FREQUENCIES).toEqual(['once', 'per_session', 'four_weeks', 'month', 'year']);
  });

  it('does not offer Week', () => {
    expect(OFFERED_FREQUENCIES).not.toContain('week');
    expect(LEGACY_FREQUENCIES).toEqual(['week']);
    expect(isLegacyFrequency('week')).toBe(true);
    expect(isLegacyFrequency('month')).toBe(false);
    expect(isLegacyFrequency(null)).toBe(false);
  });

  it('renders the five options for an item on an offered frequency', () => {
    for (const current of [null, undefined, '', 'month', 'four_weeks']) {
      const options = frequencyOptions(current);
      expect(options.map((o) => o.value)).toEqual(['once', 'per_session', 'four_weeks', 'month', 'year']);
      expect(options.every((o) => !o.disabled)).toBe(true);
    }
  });

  it('adds the item\'s own legacy frequency, disabled, so the row reads truthfully', () => {
    const options = frequencyOptions('week');
    expect(options.map((o) => o.value)).toEqual(['once', 'per_session', 'four_weeks', 'month', 'year', 'week']);
    expect(options.find((o) => o.value === 'week')?.disabled).toBe(true);
    // Everything offered stays selectable — only the retired value is blocked.
    expect(options.filter((o) => o.disabled).map((o) => o.value)).toEqual(['week']);
  });

  it('labels every option with a key the page can translate', () => {
    for (const o of frequencyOptions('week')) {
      expect(o.labelKey).toBe(`frequency_${o.value}`);
    }
  });
});

describe('the page renders the declaration, not its own list', () => {
  it('builds both selects from frequencyOptions()', () => {
    const uses = pageSrc.match(/frequencyOptions\(/g) ?? [];
    expect(uses.length).toBe(2);
    expect(pageSrc).toContain('frequencyOptions(inlineNew.billing_frequency)');
    expect(pageSrc).toContain('frequencyOptions(editForm.billing_frequency)');
  });

  it('no longer spells a frequency list out in the page', () => {
    expect(pageSrc).not.toContain('const FREQUENCIES');
    expect(pageSrc).not.toContain("'per_session'");
  });

  it('keeps the — placeholder both selects had', () => {
    expect((pageSrc.match(/<option value="">—<\/option>/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('honours the disabled flag rather than rendering every option selectable', () => {
    expect((pageSrc.match(/disabled=\{o\.disabled\}/g) ?? []).length).toBe(2);
  });

  it('warns on an item still stored as weekly', () => {
    expect(pageSrc).toContain('isLegacyFrequency(editForm.billing_frequency)');
    expect(pageSrc).toContain("t('frequency_legacy_notice')");
  });
});

describe('translations', () => {
  it('keeps a label for every option, the retired one included', () => {
    for (const code of LOCALE_CODES) {
      const ns = sellableItemsNamespace(code);
      for (const f of [...OFFERED_FREQUENCIES, ...LEGACY_FREQUENCIES]) {
        expect(ns[`frequency_${f}`], `${code}.sellable_items.frequency_${f}`).toBeTruthy();
      }
    }
  });

  it('has the legacy notice in all three languages', () => {
    for (const code of LOCALE_CODES) {
      expect(sellableItemsNamespace(code).frequency_legacy_notice, code).toBeTruthy();
    }
  });
});
