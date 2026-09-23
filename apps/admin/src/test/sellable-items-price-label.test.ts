import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Regression test for #670 — the Sellable Item field labelled "Amount" is
// displayed as "Price".
//
// The rename is terminology-only. The value behind the label is still the
// `amount` column the API returns, still formatted by the same helper, and the
// create/edit forms still submit it under the same `amount` key — so this pins
// both halves down: the new wording everywhere the field surfaces, and the
// payload/formatting that must not have moved with it.
//
// This repo has no component-test infra for apps/admin (see docs/architecture.md's
// TL;DR), so — like assigned-plan-cancel-label.test.ts (#630) — this scans the
// page source and the locale files.

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const PAGE_PATH = join(
  __dirname, '..', 'app', '[locale]', 'financials', 'sellable-items', 'page.tsx',
);
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

type Messages = Record<string, unknown>;

function sellableItemsKey(messages: Messages, key: string): string | undefined {
  const ns = messages['sellable_items'];
  if (ns == null || typeof ns !== 'object') return undefined;
  const value = (ns as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

// The source comments below name #670 and the old "Amount" wording, so the
// source scans run against comment-free code.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const locales = Object.fromEntries(
  LOCALE_CODES.map((c) => [
    c,
    JSON.parse(readFileSync(join(LOCALES_DIR, `${c}.json`), 'utf-8')) as Messages,
  ]),
) as Record<(typeof LOCALE_CODES)[number], Messages>;

const EXPECTED_LABEL: Record<(typeof LOCALE_CODES)[number], string> = {
  en: 'Price',
  es: 'Precio',
  ca: 'Preu',
};

describe('Sellable Items: "Amount" renamed to "Price" (#670)', () => {
  const source = stripComments(readFileSync(PAGE_PATH, 'utf-8'));

  it.each(LOCALE_CODES)('labels the list column and the field "Price" in %s.json', (code) => {
    expect(sellableItemsKey(locales[code], 'col_price')).toBe(EXPECTED_LABEL[code]);
    expect(sellableItemsKey(locales[code], 'label_price')).toBe(EXPECTED_LABEL[code]);
  });

  it('drops the old keys so no caller can fall back to the previous wording', () => {
    for (const code of LOCALE_CODES) {
      for (const key of ['col_amount', 'label_amount']) {
        expect(
          sellableItemsKey(locales[code], key),
          `${code}.json still defines sellable_items.${key}`,
        ).toBeUndefined();
      }
    }
    expect(source, 'the page still reads a sellable_items *_amount label').not.toMatch(
      /t\('(?:col|label)_amount'\)|labelKey: 'col_amount'/,
    );
  });

  it('never says "amount" in the namespace\'s own wording again', () => {
    // Guards the values, not the keys: a label reintroducing the old term in any
    // locale would fail here even if it were stored under a *_price key.
    const banned: Record<(typeof LOCALE_CODES)[number], RegExp> = {
      en: /\bamount\b/i,
      es: /\bimporte\b/i,
      ca: /\bimport\b/i,
    };
    for (const code of LOCALE_CODES) {
      const ns = locales[code]['sellable_items'] as Record<string, unknown>;
      for (const [key, value] of Object.entries(ns)) {
        if (typeof value !== 'string') continue;
        expect(value, `${code}.json still says the old term in sellable_items.${key}`)
          .not.toMatch(banned[code]);
      }
    }
  });

  it('renders the new label at every place the price surfaces', () => {
    // The inline create form, the inline edit form, the expanded detail row and
    // the details modal — four call sites, all on the one key.
    expect(source.match(/t\('label_price'\)/g) ?? []).toHaveLength(4);
    // The list header comes from the shared column list, in the Amount column's
    // original position (after Units, before Tax Rate).
    expect(source).toMatch(
      /labelKey: 'col_units'[\s\S]{0,80}labelKey: 'col_price'[\s\S]{0,80}labelKey: 'col_tax_rate'/,
    );
  });

  it('leaves the value, the payload and the formatting untouched', () => {
    // #670 is terminology-only: same API field, same helper, same currency format.
    expect(source).toContain('function fmtAmount(amount: string | null, currency: string)');
    expect(source).toContain("const sym = currency === 'EUR' ? '€' : currency;");
    // Both forms still submit the price under the API's `amount` key.
    expect(source).toContain("amount: inlineNew.amount !== '' ? parseFloat(inlineNew.amount) : null,");
    expect(source).toContain("amount: editForm.amount !== '' ? parseFloat(editForm.amount) : null,");
    // The list cell still prefers the tax-inclusive figure and falls back to the raw amount.
    expect(source).toContain('{item.amount_incl_tax != null');
    expect(source).toContain('fmtAmount(item.amount, item.currency)');
  });

  it('keeps unrelated "Amount" labels, which mean a different thing, unchanged', () => {
    // Payments, billing events and the membership ledger all show a transaction
    // amount, not a catalog price — the ticket scopes the rename to Sellable Items.
    for (const [namespace, key] of [
      ['member_payments', 'col_amount'],
      ['billing_events_page', 'col_amount'],
      ['memberships', 'ledger_amount'],
    ] as const) {
      const ns = locales.en[namespace] as Record<string, unknown> | undefined;
      expect(ns?.[key], `en.json lost ${namespace}.${key}`).toBe('Amount');
    }
  });
});
