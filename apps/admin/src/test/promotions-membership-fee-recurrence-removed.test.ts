import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Regression test for #814 — the Membership Fee Promotion loses Quantity, Every
// and Unit.
//
// The section inherited those three controls from the Period Benefit shape it
// was built on ("2 sessions every 3 months"). Applied to the membership fee
// they said nothing: there is one membership fee per assignment and its cadence
// is the Assigned Plan's own Billing frequency, never a Promotion's. Migration
// 199 dropped the columns.
//
// What has to stay true: the Membership Fee section renders Duration, Action,
// Value and Enabled and nothing else, its PUT body carries only those, and the
// two locale keys that existed solely for it are gone. The *other* Promotion
// benefit sections (Session / One-off / Periodical) keep their own Quantity and
// Frequency columns — they are keyed to a real Product — so this test is
// scoped to the Membership Fee functions rather than the whole file.

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const PAGE = join(__dirname, '..', 'app', '[locale]', 'promotions', 'page.tsx');
const SHARED_EDITOR = join(__dirname, '..', 'components', 'ProductBenefits.tsx');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

type Messages = Record<string, unknown>;

function loadLocale(code: string): Messages {
  return JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
}

function getNamespaceKeys(messages: Messages, namespace: string): Set<string> {
  const ns = messages[namespace];
  if (ns == null || typeof ns !== 'object') return new Set();
  return new Set(Object.keys(ns as Record<string, unknown>));
}

// Comments in the source deliberately name the removed fields (so the next
// reader knows not to add them back), so every scan runs with comments stripped.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// The brace-balanced block that starts at `needle` — used to scope the scans to
// one declaration instead of the 1,600-line page.
function extractBlock(src: string, needle: string): string {
  const start = src.indexOf(needle);
  if (start < 0) throw new Error(`could not find "${needle}" in the Promotions page`);
  const open = src.indexOf('{', start);
  if (open < 0) throw new Error(`no block after "${needle}"`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced block after "${needle}"`);
}

const RECURRENCE_FIELDS = ['quantity', 'frequency_interval', 'frequency_unit'] as const;
// Column/label keys the section rendered for those three fields. `col_quantity`
// and `col_frequency` are still used by the Product sections, which is why
// they are asserted per-block and not file-wide.
const RECURRENCE_KEYS = [
  'col_quantity',
  'col_frequency',
  'label_frequency_interval',
  'label_frequency_unit',
] as const;
// These two existed only for this section, so they leave the locale files.
const REMOVED_LOCALE_KEYS = ['label_frequency_interval', 'label_frequency_unit'] as const;

const locales = Object.fromEntries(LOCALE_CODES.map((c) => [c, loadLocale(c)])) as Record<
  (typeof LOCALE_CODES)[number],
  Messages
>;

describe('Promotions: Membership Fee recurrence fields removed (#814)', () => {
  const code = stripComments(readFileSync(PAGE, 'utf-8'));

  const blocks = {
    'the MembershipFeeBenefit type': () => extractBlock(code, 'interface MembershipFeeBenefit'),
    'the PUT body builder': () => extractBlock(code, 'function membershipFeeBody'),
    'the new-benefit default': () => extractBlock(code, 'function defaultMfDraft'),
    'the section editor': () => extractBlock(code, 'function renderMembershipFeeEditor'),
    'the read-only section': () => extractBlock(code, 'function renderMembershipFeeView'),
  };

  it('found every Membership Fee declaration it checks', () => {
    for (const [name, get] of Object.entries(blocks)) {
      expect(get(), `${name} is empty`).not.toHaveLength(0);
    }
  });

  it('declares no quantity / frequency field on the Membership Fee Benefit', () => {
    for (const [name, get] of Object.entries(blocks)) {
      const block = get();
      for (const field of RECURRENCE_FIELDS) {
        expect(block, `${name} still references "${field}"`).not.toContain(field);
      }
    }
  });

  it('renders no Quantity / Every / Unit column in either half of the section', () => {
    for (const name of ['the section editor', 'the read-only section'] as const) {
      const block = blocks[name]();
      for (const key of RECURRENCE_KEYS) {
        expect(block, `${name} still renders the column "${key}"`).not.toContain(`'${key}'`);
      }
    }
  });

  it('keeps Duration, Action, Value and Enabled in the section', () => {
    const editor = blocks['the section editor']();
    const view = blocks['the read-only section']();
    // #919/#920 renamed the column key: the duration is a count of membership
    // periods, so it is labelled `Duration` (`col_duration`) rather than
    // `Duration (months)`. The column itself is still here, which is what this
    // asserts.
    for (const key of ['col_duration', 'col_action', 'col_value', 'col_enabled']) {
      expect(editor, `the section editor no longer renders "${key}"`).toContain(`'${key}'`);
      expect(view, `the read-only section no longer renders "${key}"`).toContain(`'${key}'`);
    }
  });

  it('keeps the editor grid and the read-only table on the same five columns', () => {
    // Benefit type + Duration + Action + Value + Enabled. The grid template is
    // what keeps the editor's header row aligned with its inputs, so a column
    // removed from one half and not the other would show up here.
    const editor = blocks['the section editor']();
    const template = editor.match(/gridTemplateColumns: '([^']+)'/);
    expect(template, 'the section editor has no grid template').not.toBeNull();
    expect(template![1].trim().split(/\s+/)).toHaveLength(5);

    const view = blocks['the read-only section']();
    expect(view.match(/<th /g) ?? [], 'the read-only table is not five columns').toHaveLength(5);
    expect(view.match(/<td /g) ?? [], 'the read-only row is not five cells').toHaveLength(5);
  });

  it('drops the week/month unit selector the section was the only user of', () => {
    expect(code, 'FREQ_UNITS is still declared').not.toContain('FREQ_UNITS');
  });

  it('drops the Every / Unit labels from the "promotions" namespace in every locale', () => {
    for (const locale of LOCALE_CODES) {
      const keys = getNamespaceKeys(locales[locale], 'promotions');
      const leftover = REMOVED_LOCALE_KEYS.filter((k) => keys.has(k));
      expect(leftover, `${locale}.json still has removed "promotions" keys`).toEqual([]);
    }
  });

  it('keeps col_quantity and col_frequency, which the Product sections still use', () => {
    for (const locale of LOCALE_CODES) {
      const keys = getNamespaceKeys(locales[locale], 'promotions');
      expect(keys.has('col_quantity'), `${locale}.json lost promotions.col_quantity`).toBe(true);
      expect(keys.has('col_frequency'), `${locale}.json lost promotions.col_frequency`).toBe(true);
    }
    // #896 stage 4: the three Product sections render through the shared
    // editor now, so the Quantity column is declared there — the page names the
    // context, the component names the columns.
    expect(code, 'the Product sections no longer render through the shared editor')
      .toContain('benefitContext="promotion"');
    const sharedSrc = stripComments(readFileSync(SHARED_EDITOR, 'utf-8'));
    expect(sharedSrc, 'the shared editor lost its Quantity column').toContain("t('col_quantity')");
  });

  it('has an identical "promotions" key set across every supported locale (en/es/ca)', () => {
    const enKeys = getNamespaceKeys(locales.en, 'promotions');
    expect(enKeys.size).toBeGreaterThan(0);
    for (const locale of LOCALE_CODES) {
      if (locale === 'en') continue;
      const keys = getNamespaceKeys(locales[locale], 'promotions');
      expect([...enKeys].filter((k) => !keys.has(k)), `${locale}.json is missing "promotions" keys`).toEqual([]);
      expect([...keys].filter((k) => !enKeys.has(k)), `${locale}.json has stray "promotions" keys`).toEqual([]);
    }
  });
});
