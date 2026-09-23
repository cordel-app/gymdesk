import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Regression test for #637 — Sellable Items column alignment.
//
// The header row and every item row used to be independent flex rows whose
// cells only carried a `minWidth`, so any value wider than its minimum (a long
// name, a long "created by") widened that cell and pushed every column after it
// out of line with the header. The fix is one shared grid template used by both,
// with the list scrolling horizontally when the viewport is too narrow.
//
// This repo has no component-test infra for apps/admin (see docs/architecture.md's
// TL;DR), so — like promotions-section-editing.test.ts (#627) — this pins the
// structure down by scanning the page source and the locale files.

const PAGE_PATH = join(
  __dirname, '..', 'app', '[locale]', 'financials', 'sellable-items', 'page.tsx',
);
const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

// The columns the ticket requires, in the order it lists them.
const EXPECTED_COLUMNS = [
  'col_name',
  'col_type',
  'col_units',
  'col_price',
  'col_tax_rate',
  'col_frequency',
  'col_created_by',
  'col_created_at',
  'col_status',
  'col_enrollment_status',
  'col_actions',
] as const;

// Comments in the source name #637 and describe the old per-cell minWidth
// layout, so every scan below runs on comment-free code.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const pageSrc = stripComments(readFileSync(PAGE_PATH, 'utf-8'));

// The collapsed row: everything between the row container and the inline editor.
const collapsedRowSrc = pageSrc.match(
  /<div style={rowStyle}[\s\S]*?\n {8}<\/div>\n/,
)?.[0] ?? '';

const locales = Object.fromEntries(
  LOCALE_CODES.map((c) => [c, JSON.parse(readFileSync(join(LOCALES_DIR, `${c}.json`), 'utf-8'))]),
) as Record<(typeof LOCALE_CODES)[number], Record<string, Record<string, unknown>>>;

describe('Sellable Items: column alignment (#637)', () => {
  it('extracts the collapsed row to scan', () => {
    expect(collapsedRowSrc, 'the collapsed row could not be located in the source').not.toBe('');
  });

  it('declares every column once, in the ticket\'s order', () => {
    const declared = [...pageSrc.matchAll(/labelKey: '(col_[a-z_]+)'/g)].map((m) => m[1]);
    expect(declared).toEqual([...EXPECTED_COLUMNS]);
  });

  it('derives the grid template and the scroll threshold from that one list', () => {
    // Both are computed from LIST_COLUMNS, so a column can't be added to the
    // header without also widening the rows it has to line up with.
    expect(pageSrc).toMatch(/const LIST_GRID_COLUMNS = LIST_COLUMNS\s*\n\s*\.map\(/);
    expect(pageSrc).toMatch(/const LIST_MIN_WIDTH =\s*\n\s*LIST_COLUMNS\.reduce\(/);
    // Exactly one flexible track: the name column absorbs the leftover width.
    const flexible = [...pageSrc.matchAll(/grow: \d+/g)];
    expect(flexible).toHaveLength(1);
    expect(pageSrc).toMatch(/\{ labelKey: 'col_name', width: \d+, grow: \d+ \}/);
  });

  it('lays the header and the rows out on the same grid', () => {
    expect(pageSrc).toMatch(/const listGridStyle: React\.CSSProperties = \{\s*\n\s*display: 'grid',\s*\n\s*gridTemplateColumns: LIST_GRID_COLUMNS,/);
    expect(pageSrc, 'rowStyle no longer builds on the shared grid').toMatch(/const rowStyle: React\.CSSProperties = \{\s*\n\s*\.\.\.listGridStyle,/);
    expect(pageSrc, 'colHeaderStyle no longer builds on the shared grid').toMatch(/const colHeaderStyle: React\.CSSProperties = \{\s*\n\s*\.\.\.listGridStyle,/);
    // Same horizontal inset on both, plus the 1px the rows' card border adds.
    expect(pageSrc).toMatch(/padding: `12px \$\{LIST_ROW_PADDING_X\}px`/);
    expect(pageSrc).toMatch(/padding: `6px \$\{LIST_ROW_PADDING_X\}px`/);
    expect(pageSrc).toMatch(/border: '1px solid transparent'/);
  });

  it('renders the headers from the shared column list', () => {
    expect(pageSrc).toMatch(/LIST_COLUMNS\.map\(\(col\) => \(/);
    expect(pageSrc).toMatch(/\{t\(col\.labelKey\)\}/);
  });

  it('gives the collapsed row exactly one cell per column', () => {
    const cells = [...collapsedRowSrc.matchAll(/style=\{(?:\{ \.\.\.cellStyle|cellStyle|badgeCellStyle|actionsCellStyle)/g)];
    expect(cells).toHaveLength(EXPECTED_COLUMNS.length);
    // The chevron and the context menu share the Actions cell rather than
    // sitting in tracks of their own.
    expect(collapsedRowSrc).toMatch(/style=\{actionsCellStyle\}[\s\S]*?<ContextMenu/);
  });

  it('keeps a long value inside its own column', () => {
    expect(pageSrc).toMatch(/const cellStyle: React\.CSSProperties = \{\s*\n\s*minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',/);
    // No cell may reintroduce a content-sized track by pinning its own width.
    expect(collapsedRowSrc).not.toMatch(/minWidth: \d/);
    expect(collapsedRowSrc).not.toMatch(/flexShrink/);
    expect(collapsedRowSrc).not.toMatch(/flex: \d/);
  });

  it('scrolls horizontally instead of dropping columns when the viewport is narrow', () => {
    expect(pageSrc).toMatch(/overflowX: 'auto'/);
    expect(pageSrc).toMatch(/minWidth: LIST_MIN_WIDTH/);
    // The headers and the rows scroll as one, so they cannot drift apart.
    const scroller = pageSrc.match(/<div style=\{\{ overflowX: 'auto' \}\}>[\s\S]*?\{items\.map\(renderRow\)\}/)?.[0] ?? '';
    expect(scroller, 'the rows are not inside the scrolling wrapper').not.toBe('');
    expect(scroller).toMatch(/style=\{colHeaderStyle\}/);
  });

  it('translates every column header, Actions included, in all locales', () => {
    for (const code of LOCALE_CODES) {
      const ns = locales[code].sellable_items;
      expect(ns, `${code}.json has no sellable_items namespace`).toBeTruthy();
      for (const key of EXPECTED_COLUMNS) {
        expect(String(ns[key] ?? ''), `${code}.json is missing sellable_items.${key}`).not.toBe('');
      }
    }
  });

  it('leaves the row data and actions untouched', () => {
    // #637 is presentation-only: the same values and the same menu as before.
    for (const marker of [
      '{item.name}',
      '{t(`type_${item.type}`)}',
      '{fmtDate(item.created_at)}',
      'label={tStatus(item.status)}',
      'label={tStatus(item.enrollment_status)}',
    ]) {
      expect(collapsedRowSrc, `the row no longer renders ${marker}`).toContain(marker);
    }
    expect(collapsedRowSrc).toMatch(/onClick=\{\(\) => toggleExpand\(item\.id\)\}/);
    expect(collapsedRowSrc).toMatch(/ariaLabel=\{`Actions for \$\{item\.name\}`\}/);
  });
});
