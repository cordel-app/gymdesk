import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #894 — the Mandatory status is visible in a Product's card header.
//
// #832 gave the flag a checkbox in both forms and a row in the two read-only
// surfaces, which meant a gym owner had to open a card (or its Edit form) to
// learn whether an item was mandatory. This ticket adds a compact badge beside
// the name, next to the `System` one, for items where `mandatory = true`.
//
// This repo has no component-test infra for apps/admin (see docs/architecture.md's
// TL;DR), so — like products-column-alignment.test.ts (#637) — the
// structure is pinned by scanning the page source and the locale files.

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

const PRODUCTS_PAGE = join(
  __dirname, '..', 'app', '[locale]', 'financials', 'products', 'page.tsx',
);
const LIST_CHROME = join(__dirname, '..', 'components', 'listChrome.ts');
// The other two pages drawing a name-cell badge, which #894 moved onto the
// shared style rather than leaving each with its own copy of the literal.
const OTHER_BADGE_PAGES = [
  join(__dirname, '..', 'app', '[locale]', 'financials', 'taxes', 'page.tsx'),
  join(__dirname, '..', 'app', '[locale]', 'professional-services', 'page.tsx'),
];

/** The source comments name the ticket, so every scan runs on stripped code. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const page = stripComments(readFileSync(PRODUCTS_PAGE, 'utf-8'));

/** The collapsed header only: everything before the inline editor. */
const header = page.match(/<div className={LIST_GRID_ROW_CLASS} style={rowStyle}[\s\S]*?\n {8}<\/div>\n/)?.[0] ?? '';
/** The name cell inside it, which is where both badges belong. */
const nameCell = header.match(/<div className=\{CELL_CLASS\.name\} style=\{\{ \.\.\.cellStyle, fontWeight: 600[\s\S]*?\n {10}<\/div>/)?.[0] ?? '';

function productsKey(code: string, key: string): string | undefined {
  const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8')) as Record<string, unknown>;
  const ns = messages['products'];
  if (ns == null || typeof ns !== 'object') return undefined;
  const value = (ns as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

describe('Products: Mandatory badge in the card header (#894)', () => {
  it('locates the collapsed header and its name cell', () => {
    expect(header, 'the collapsed header could not be located').not.toBe('');
    expect(nameCell, 'the name cell could not be located').not.toBe('');
  });

  it('renders the badge in the header, not only in the expanded card', () => {
    expect(nameCell).toContain("{t('mandatory_badge')}");
    // §3: after the name and after the System badge.
    expect(nameCell.indexOf('{item.name}')).toBeLessThan(nameCell.indexOf("{t('system_badge')}"));
    expect(nameCell.indexOf("{t('system_badge')}")).toBeLessThan(nameCell.indexOf("{t('mandatory_badge')}"));
  });

  it('shows it only for a mandatory item, read from the column', () => {
    // §4: the flag itself decides, never the name or the type.
    expect(page).toContain('const isMandatory = Boolean(item.mandatory);');
    expect(nameCell).toMatch(/\{isMandatory && \(\s*\n\s*<span style=\{listNameBadgeAccentStyle\}>/);
    expect(nameCell).not.toMatch(/item\.name ===|item\.type ===|charge_type_code/);
  });

  it('keeps the badge read-only — no control in the header (§5)', () => {
    const badge = nameCell.match(/\{isMandatory && \([\s\S]*?\)\}/)?.[0] ?? '';
    expect(badge, 'the badge block could not be located').not.toBe('');
    for (const control of ['<input', 'checkbox', 'onChange', 'onClick', '<button']) {
      expect(badge, `the header badge must not carry ${control}`).not.toContain(control);
    }
  });

  it('leaves the edit form as the place the flag is configured', () => {
    expect(page).toContain('checked={editForm.mandatory}');
    expect(page).toContain('checked={inlineNew.mandatory}');
    expect(page).toContain('mandatory: editForm.mandatory');
  });

  it('leaves the Status and Enrollment badges in their own columns', () => {
    // The two StatusBadge cells are unchanged: the new pill sits on the name.
    expect(header).toContain('label={tStatus(item.status)}');
    expect(header).toContain('label={tStatus(item.enrollment_status)}');
    expect([...header.matchAll(/<StatusBadge/g)]).toHaveLength(2);
  });

  it('takes the pill look from the shared list chrome, not from a page literal', () => {
    const chrome = readFileSync(LIST_CHROME, 'utf-8');
    expect(chrome).toContain('export const listNameBadgeStyle');
    expect(chrome).toContain('export const listNameBadgeAccentStyle');
    for (const file of [PRODUCTS_PAGE, ...OTHER_BADGE_PAGES]) {
      const src = readFileSync(file, 'utf-8');
      expect(src, `${file} does not import the shared badge style`)
        .toMatch(/import \{[^}]*\blistNameBadgeStyle\b[^}]*\} from '@\/components\/listChrome';/);
      expect(src, `${file} still restates the badge style inline`)
        .not.toMatch(/marginLeft: 6, fontSize: 11, fontWeight: 500/);
    }
  });

  it.each(LOCALE_CODES)('translates the badge label in %s.json', (code) => {
    expect(productsKey(code, 'mandatory_badge'), `${code}.json is missing products.mandatory_badge`)
      .toBeTypeOf('string');
    // The System badge keeps its own key: the two are not one label.
    expect(productsKey(code, 'system_badge')).toBeTypeOf('string');
  });
});

// #913 — the Mandatory pill is the accent one, the System pill is not.
//
// The badge landed on the neutral `listNameBadgeStyle`, which is right for
// `System` ("what kind of row is this") but made the Mandatory status read as
// part of the row's chrome. The ticket asks for a more prominent background
// only: same size, type, padding and radius, no new theme token, System
// untouched. So what is pinned here is that the accent style is *derived* from
// the neutral one rather than written out again, and that it changes exactly
// the two colour properties.
describe('Products: the Mandatory pill is visually distinct (#913)', () => {
  const chrome = readFileSync(LIST_CHROME, 'utf-8');
  const accent = chrome.match(/export const listNameBadgeAccentStyle: React\.CSSProperties = \{[\s\S]*?\n\};/)?.[0] ?? '';
  const neutral = chrome.match(/export const listNameBadgeStyle: React\.CSSProperties = \{[\s\S]*?\n\};/)?.[0] ?? '';

  it('declares the accent pill beside the neutral one', () => {
    expect(accent, 'listNameBadgeAccentStyle could not be located').not.toBe('');
    expect(neutral, 'listNameBadgeStyle could not be located').not.toBe('');
  });

  it('inherits the neutral pill\'s geometry and type instead of restating it', () => {
    // The spread is what keeps sizing, typography, padding and radius shared:
    // a value changed on the neutral pill reaches this one too.
    expect(accent).toContain('...listNameBadgeStyle');
    for (const prop of ['marginLeft', 'fontSize', 'fontWeight', 'borderRadius', 'padding', 'verticalAlign']) {
      expect(accent, `the accent pill must not restate ${prop}`).not.toMatch(new RegExp(`\\n\\s*${prop}:`));
    }
  });

  it('changes the two colours and nothing else, with no new theme token', () => {
    const overrides = [...accent.matchAll(/\n\s{2}([A-Za-z]+):/g)].map((m) => m[1]);
    expect(overrides.sort()).toEqual(['background', 'color']);
    // The pair the existing badge uses is a literal too (#894), so a Theme
    // variable is not required here — and adding one would be a new token.
    expect(accent).not.toContain('--gd-');
  });

  it('does not reuse the System pill\'s own colours', () => {
    const colours = (style: string) => [...style.matchAll(/#[0-9a-fA-F]{3,6}/g)].map((m) => m[0].toLowerCase());
    const accentColours = colours(accent);
    expect(accentColours).toHaveLength(2);
    for (const colour of colours(neutral)) {
      expect(accentColours, 'the accent pill repeats a System pill colour').not.toContain(colour);
    }
  });

  it('leaves the System badge and the other two pages on the neutral pill', () => {
    const systemBadge = nameCell.match(/\{isSystem && \([\s\S]*?\)\}/)?.[0] ?? '';
    expect(systemBadge, 'the System badge block could not be located').not.toBe('');
    expect(systemBadge).toContain('style={listNameBadgeStyle}');
    expect(systemBadge).not.toContain('listNameBadgeAccentStyle');
    for (const file of OTHER_BADGE_PAGES) {
      expect(readFileSync(file, 'utf-8'), `${file} should not have moved to the accent pill`)
        .not.toContain('listNameBadgeAccentStyle');
    }
  });

  it('renders nothing extra for an item that is not mandatory', () => {
    // The pill is still the whole of it: one conditional, no wrapper, no
    // placeholder for the non-mandatory case.
    expect([...nameCell.matchAll(/isMandatory/g)]).toHaveLength(1);
  });
});
