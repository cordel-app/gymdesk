import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  SESSION_ITEM_TYPE,
  sessionPackageNote,
  sessionPackageNoteForForm,
  taxNoteKey,
} from '@/app/[locale]/financials/products/productPriceNotes';

// #942 — a Product of Type `Sessions` quotes the total price of the
// package, not the price of one session. `Units: 5` beside `Price: €50.00` reads
// as €50.00 each, and the ticket is that the UI never says otherwise.
//
// The change is labels only: no number this page displays moves, and nothing
// here or in the page multiplies, divides or re-derives a price (AC 1, AC 8).
// So this file covers two things — the pure rule that decides which sentence
// belongs beside a price, and the five places the page has to render it.
//
// apps/admin has no component-test infra (docs/architecture.md's TL;DR), so the
// page is pinned by scanning its source the way product-frequency.test.ts
// and products-price-label.test.ts do, while the declaration's pure parts
// are exercised directly.

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const PAGE = join(__dirname, '..', 'app', '[locale]', 'financials', 'products', 'page.tsx');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

type Messages = Record<string, unknown>;

const locales = Object.fromEntries(
  LOCALE_CODES.map((c) => [
    c,
    JSON.parse(readFileSync(join(LOCALES_DIR, `${c}.json`), 'utf-8')) as Messages,
  ]),
) as Record<(typeof LOCALE_CODES)[number], Messages>;

function key(code: (typeof LOCALE_CODES)[number], k: string): string | undefined {
  const ns = locales[code]['products'];
  if (ns == null || typeof ns !== 'object') return undefined;
  const value = (ns as Record<string, unknown>)[k];
  return typeof value === 'string' ? value : undefined;
}

// The source comments name #942 and spell out the wording they explain, so the
// source scans run against comment-free code.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const source = stripComments(readFileSync(PAGE, 'utf-8'));

describe('#942 sessionPackageNote: which sentence belongs beside a price', () => {
  it('names the session package wording with the item\'s own Units', () => {
    expect(sessionPackageNote({ type: SESSION_ITEM_TYPE, units: 5 }))
      .toEqual({ key: 'price_total_for_sessions', count: 5 });
    expect(sessionPackageNote({ type: SESSION_ITEM_TYPE, units: 10 }))
      .toEqual({ key: 'price_total_for_sessions', count: 10 });
  });

  it('counts one session as one, for the singular form (AC 5)', () => {
    expect(sessionPackageNote({ type: SESSION_ITEM_TYPE, units: 1 }))
      .toEqual({ key: 'price_total_for_sessions', count: 1 });
  });

  it('says nothing for every other type, so fee-based items are untouched (AC 7)', () => {
    for (const type of ['fee', 'service', 'merchandise', 'other']) {
      expect(sessionPackageNote({ type, units: 5 }), `${type} got a session note`).toBeNull();
      expect(sessionPackageNote({ type, units: null })).toBeNull();
    }
  });

  it('falls back to the package wording when a session item has no Units', () => {
    // `products.units` is nullable and the form accepts an empty value.
    // Saying nothing there would leave exactly the ambiguity the ticket is about.
    expect(sessionPackageNote({ type: SESSION_ITEM_TYPE, units: null }))
      .toEqual({ key: 'price_total_for_package' });
    expect(sessionPackageNote({ type: SESSION_ITEM_TYPE, units: 0 }))
      .toEqual({ key: 'price_total_for_package' });
    expect(sessionPackageNote({ type: SESSION_ITEM_TYPE, units: -3 }))
      .toEqual({ key: 'price_total_for_package' });
    expect(sessionPackageNote({ type: SESSION_ITEM_TYPE, units: NaN }))
      .toEqual({ key: 'price_total_for_package' });
  });

  it('never reports a fractional count', () => {
    expect(sessionPackageNote({ type: SESSION_ITEM_TYPE, units: 5.7 }))
      .toEqual({ key: 'price_total_for_sessions', count: 5 });
  });
});

describe('#942 sessionPackageNoteForForm: the note tracks the form being filled in', () => {
  it('appears as soon as Type is Sessions, with the typed Units', () => {
    expect(sessionPackageNoteForForm({ type: SESSION_ITEM_TYPE, units: '5' }))
      .toEqual({ key: 'price_total_for_sessions', count: 5 });
    expect(sessionPackageNoteForForm({ type: SESSION_ITEM_TYPE, units: ' 1 ' }))
      .toEqual({ key: 'price_total_for_sessions', count: 1 });
  });

  it('renders the package wording rather than NaN for an empty or junk Units', () => {
    expect(sessionPackageNoteForForm({ type: SESSION_ITEM_TYPE, units: '' }))
      .toEqual({ key: 'price_total_for_package' });
    expect(sessionPackageNoteForForm({ type: SESSION_ITEM_TYPE, units: 'abc' }))
      .toEqual({ key: 'price_total_for_package' });
  });

  it('stays silent while the form is on another type', () => {
    expect(sessionPackageNoteForForm({ type: 'fee', units: '5' })).toBeNull();
  });
});

describe('#942 taxNoteKey: a displayed price says what it includes (AC 2)', () => {
  it('reports the inclusive suffix for an inclusive item', () => {
    expect(taxNoteKey({ tax_behavior: 'inclusive', applied_tax_rate: 21 })).toBe('taxIncluded');
  });

  it('reports the exclusive suffix rather than claiming tax is included', () => {
    expect(taxNoteKey({ tax_behavior: 'exclusive', applied_tax_rate: 21 })).toBe('taxExcluded');
  });

  it('says nothing when the item has no tax rate', () => {
    // `computePriceFields()` leaves `applied_tax_rate` null for an item with no
    // rate, and the list already falls back to the raw amount there. Annotating
    // it "(tax included)" would claim a tax that is not configured.
    expect(taxNoteKey({ tax_behavior: 'inclusive', applied_tax_rate: null })).toBeNull();
    expect(taxNoteKey({ tax_behavior: 'exclusive', applied_tax_rate: null })).toBeNull();
  });

  it('still answers for a zero rate, which is Exempt and not "no rate"', () => {
    expect(taxNoteKey({ tax_behavior: 'inclusive', applied_tax_rate: 0 })).toBe('taxIncluded');
  });
});

describe('#942 locale keys', () => {
  it.each(LOCALE_CODES)('defines both sentences in %s.json', (code) => {
    expect(key(code, 'price_total_for_sessions')).toBeTruthy();
    expect(key(code, 'price_total_for_package')).toBeTruthy();
  });

  it.each(LOCALE_CODES)('pluralises the session count in ICU in %s.json (AC 4, AC 5)', (code) => {
    const message = key(code, 'price_total_for_sessions')!;
    // The count has to come from the item's Units, interpolated — a hardcoded
    // number or a key per count would fail AC 4.
    expect(message, `${code}.json does not take a count`).toMatch(/\{count,\s*plural,/);
    expect(message, `${code}.json has no singular form`).toMatch(/\bone\s*\{/);
    expect(message, `${code}.json has no plural form`).toMatch(/\bother\s*\{/);
  });

  it.each(LOCALE_CODES)('keeps the tax suffix the sentence sits under in %s.json', (code) => {
    expect(key(code, 'taxIncluded')).toBeTruthy();
    expect(key(code, 'taxExcluded')).toBeTruthy();
  });

  it('never says a per-session price in any locale', () => {
    // The whole point is that €50.00 is not the price of one session, so no
    // wording of these two keys may read that way.
    const banned: Record<(typeof LOCALE_CODES)[number], RegExp> = {
      en: /\bper session\b/i,
      es: /\bpor sesi(ó|o)n\b/i,
      ca: /\bper sessi(ó|o)\b/i,
    };
    for (const code of LOCALE_CODES) {
      for (const k of ['price_total_for_sessions', 'price_total_for_package']) {
        expect(key(code, k), `${code}.json reads as a per-session price in ${k}`)
          .not.toMatch(banned[code]);
      }
    }
  });
});

describe('#942 the page renders the note everywhere a price surfaces', () => {
  it('asks the shared rule rather than testing the type itself', () => {
    // One rule, five call sites. A page spelling out `type === 'sessions'` beside
    // a price is a second rule that can drift from this one.
    expect(source).toContain("from './productPriceNotes'");
    expect(source).not.toMatch(/'sessions'\s*(?:===|!==)|(?:===|!==)\s*'sessions'/);
  });

  it('shows it in the collapsed row and the expanded card, from one resolution', () => {
    expect(source).toContain('const sessionNote = noteText(sessionPackageNote(item));');
    // `title` too: the cell is nowrap-and-ellipsis, so a sentence long enough
    // to be cut still reads on hover.
    expect(source).toContain(
      '{sessionNote && <span style={listHintStyle} title={sessionNote}>{sessionNote}</span>}',
    );
    // #974: the expanded card renders Price through the shared layout, so the
    // note is a line under the value rather than a `hint` prop — same rule,
    // same resolution, one layout for both halves of the card.
    expect(source).toMatch(
      /case 'amount':[\s\S]{0,500}\{sessionNote && <p style=\{valueHintStyle\}>\{sessionNote\}<\/p>\}/,
    );
  });

  it('shows it in the Details modal', () => {
    expect(source).toMatch(
      /label=\{t\('label_price'\)\}[\s\S]{0,200}hint=\{noteText\(sessionPackageNote\(details\)\)\}/,
    );
  });

  it('shows it under the Price input in both forms, off their live values (#805)', () => {
    // The editor reads the *form*, not the saved row, so changing Type or Units
    // updates the sentence before Save.
    expect(source).toContain('const draftSessionNote = noteText(sessionPackageNoteForForm(inlineNew));');
    expect(source).toContain('noteText(sessionPackageNoteForForm(editForm))');
    expect(source).toContain('{draftSessionNote && <p style={formHelpTextStyle}>{draftSessionNote}</p>}');
    expect(source).toContain('{editSessionNote && <p style={formHelpTextStyle}>{editSessionNote}</p>}');
  });

  it('leaves the collapsed Price cell room for the sentence it now carries', () => {
    // Every cell on the #637 grid is nowrap-and-ellipsis, so the track has to be
    // wide enough for the longest of these sentences in en/es/ca.
    expect(source).toMatch(/\{ key: 'price', labelKey: 'col_price', width: (?:19\d|2\d\d), mobile: '[a-z]+' \}/);
  });

  it('annotates the price with its tax suffix on the two surfaces that lacked one', () => {
    expect(source).toContain('withTaxNote(fmtAmount(item.amount, item.currency), item)');
    expect(source).toContain('withTaxNote(fmtAmount(details.amount, details.currency), details)');
  });

  it('changes no displayed figure and no payload (AC 1, AC 8)', () => {
    // The collapsed row's price expression is untouched: the tax-inclusive
    // figure when the API computed one, the raw amount otherwise.
    expect(source).toContain('{item.amount_incl_tax != null');
    expect(source).toContain('fmtAmount(item.amount, item.currency)');
    // Both forms still submit the price under the API's `amount` key, unscaled.
    expect(source).toContain("amount: inlineNew.amount !== '' ? parseFloat(inlineNew.amount) : null,");
    expect(source).toContain("amount: editForm.amount !== '' ? parseFloat(editForm.amount) : null,");
    // Nothing on this page multiplies a price by a unit count.
    expect(source).not.toMatch(/amount[^\n]*\*\s*(?:units|item\.units|Number\(.*units)/);
  });

  it('does not restate the help line\'s chrome (#929)', () => {
    expect(source).toMatch(/formHelpTextStyle,[\s\S]{0,400}\} from '@\/components\/formChrome';/);
    expect(source).not.toMatch(/const formHelpTextStyle/);
  });
});
