import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  LEGACY_FREQUENCIES,
  OFFERED_FREQUENCIES,
  frequencyOptions,
  isLegacyFrequency,
  legacyFrequencyLabelKey,
} from '@/app/[locale]/financials/sellable-items/sellableItemFrequency';
import { EMPTY_VALUE } from '@/app/[locale]/financials/sellable-items/sellableItemProfile';

// #821 / #945 — a Sellable Item's Billing Frequency dropdown offers four choices.
//
//   Before #821:  — / Once / Per Session / 4 Weeks / Week / Month / Year
//   After  #821:  — / Once / Per Session / 4 Weeks / Month / Year
//   After  #945:  — / Once / 4 Weeks / Month / Year
//
// Neither retired value is deleted from the data: an item configured before the
// ticket that retired it still stores it, still bills on it and still
// classifies into the same benefit section. The API is what enforces the rule
// (`api/src/domain/sellableItemFrequency.ts`, exercised by `gym-charges.test.ts`);
// this file covers the declaration and the two places the page renders it — the
// inline create card and the inline editor, which must render the same list (#805).
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
  it('offers exactly the four choices the ticket lists, in that order', () => {
    expect(OFFERED_FREQUENCIES).toEqual(['once', 'four_weeks', 'month', 'year']);
  });

  it('does not offer Per Session', () => {
    expect(OFFERED_FREQUENCIES).not.toContain('per_session');
    expect(isLegacyFrequency('per_session')).toBe(true);
  });

  it('does not offer Week either, and keeps both retired values known', () => {
    expect(OFFERED_FREQUENCIES).not.toContain('week');
    expect([...LEGACY_FREQUENCIES].sort()).toEqual(['per_session', 'week']);
    expect(isLegacyFrequency('week')).toBe(true);
    expect(isLegacyFrequency('month')).toBe(false);
    expect(isLegacyFrequency(null)).toBe(false);
  });

  it('renders the four options for an item on an offered frequency', () => {
    for (const current of [null, undefined, '', 'month', 'four_weeks']) {
      const options = frequencyOptions(current);
      expect(options.map((o) => o.value)).toEqual(['once', 'four_weeks', 'month', 'year']);
      expect(options.every((o) => !o.disabled)).toBe(true);
    }
  });

  it('adds the item\'s own legacy frequency, disabled, so the row reads truthfully', () => {
    for (const legacy of ['per_session', 'week'] as const) {
      const options = frequencyOptions(legacy);
      expect(options.map((o) => o.value)).toEqual(['once', 'four_weeks', 'month', 'year', legacy]);
      expect(options.find((o) => o.value === legacy)?.disabled).toBe(true);
      // Everything offered stays selectable — only the retired value is blocked,
      // and never the *other* retired value the item does not hold.
      expect(options.filter((o) => o.disabled).map((o) => o.value)).toEqual([legacy]);
    }
  });

  it('labels every option with a key the page can translate', () => {
    for (const o of frequencyOptions('per_session')) {
      expect(o.labelKey).toBe(`frequency_${o.value}`);
    }
  });

  it('names the held legacy value for the notice, and nothing otherwise', () => {
    expect(legacyFrequencyLabelKey('per_session')).toBe('frequency_per_session');
    expect(legacyFrequencyLabelKey('week')).toBe('frequency_week');
    for (const offered of [...OFFERED_FREQUENCIES, '', null, undefined]) {
      expect(legacyFrequencyLabelKey(offered)).toBeNull();
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
    expect(pageSrc).not.toContain("'week'");
  });

  it('keeps the — placeholder both selects had', () => {
    // #974: the inline editor spells it `{EMPTY_VALUE}` — the one placeholder
    // the card's field declaration declares, so every unset value on the card
    // reads the same way — while the create card still carries the literal.
    const placeholders = pageSrc.match(/<option value="">(?:—|\{EMPTY_VALUE\})<\/option>/g) ?? [];
    expect(placeholders.length).toBeGreaterThanOrEqual(2);
    expect(EMPTY_VALUE).toBe('—');
  });

  it('honours the disabled flag rather than rendering every option selectable', () => {
    expect((pageSrc.match(/disabled=\{o\.disabled\}/g) ?? []).length).toBe(2);
  });

  it('flags an item still stored on a retired frequency, naming which one', () => {
    expect(pageSrc).toContain('legacyFrequencyLabelKey(editForm.billing_frequency)');
    expect(pageSrc).toContain("t('frequency_legacy_notice', { frequency: t(editLegacyFrequencyLabelKey as any) })");
  });
});

// #945 §2: "Configuring a Sellable Item within other entities, where the same
// Billing Frequency selector is used." There is no such other entity — the
// offered list has exactly one consumer, and every other surface *displays* a
// stored frequency (`t(`frequency_${value}`)`, legacy values included) rather
// than offering it. This pins that, so a second selector cannot appear
// somewhere that keeps offering Per Session.
describe('the offered list has one consumer', () => {
  it('is imported by the sellable-items page and nothing else', () => {
    const roots = [join(__dirname, '..', 'app'), join(__dirname, '..', 'components'), join(__dirname, '..', 'lib')];
    const importers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.tsx?$/.test(entry.name)) continue;
        if (entry.name === 'sellableItemFrequency.ts') continue; // the declaration itself
        if (readFileSync(full, 'utf-8').includes("from './sellableItemFrequency'")
          || readFileSync(full, 'utf-8').includes('financials/sellable-items/sellableItemFrequency')) {
          importers.push(full);
        }
      }
    };
    for (const root of roots) walk(root);
    expect(importers.map((f) => f.replace(join(__dirname, '..'), ''))).toEqual([
      join('/app', '[locale]', 'financials', 'sellable-items', 'page.tsx'),
    ]);
  });
});

describe('translations', () => {
  it('keeps a label for every option, the retired ones included', () => {
    for (const code of LOCALE_CODES) {
      const ns = sellableItemsNamespace(code);
      for (const f of [...OFFERED_FREQUENCIES, ...LEGACY_FREQUENCIES]) {
        expect(ns[`frequency_${f}`], `${code}.sellable_items.frequency_${f}`).toBeTruthy();
      }
    }
  });

  it('has the legacy notice in all three languages, interpolating the frequency', () => {
    for (const code of LOCALE_CODES) {
      const notice = sellableItemsNamespace(code).frequency_legacy_notice;
      expect(notice, code).toBeTruthy();
      // #945: two retired values now, so the sentence can no longer name one
      // of them itself — it takes the label as a value.
      expect(notice, code).toContain('{frequency}');
      expect(notice?.toLowerCase(), code).not.toContain('weekly');
      expect(notice?.toLowerCase(), code).not.toContain('semanal');
      expect(notice?.toLowerCase(), code).not.toContain('setmanal');
    }
  });
});
