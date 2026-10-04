import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #928 — the Members list wears the same list as Products.
//
// Members was the one staff list still rendered by `DataTable`: its column
// widths were per-cell hints with nothing underneath them, and its five filters
// sat unlabelled in a page-level toolbar above the table. Products and
// Training Plans had already moved to the shared shape — one `LIST_COLUMNS`
// grid for the header band and the rows, both inside one `overflow-x: auto`
// wrapper (#637), with the surface, band, cell insets and dividers coming from
// `listChrome` (the ones `DataTable` itself is built from, #724) and the filters
// from `FilterBar`/`FilterField`.
//
// The ticket is presentation only: same columns, same values, same filters,
// same actions, same expand/collapse, same `+ Add Member`. The scans below pin
// both halves of that down — the new structure, and everything that must not
// have changed with it.
//
// This repo has no component-test infra for apps/admin (see docs/architecture.md's
// TL;DR), so — like products-column-alignment.test.ts (#637) and
// training-plans-list-header.test.ts (#724) — this reads the sources and the
// locale files.

const SRC = join(__dirname, '..');
const PAGE_PATH = join(SRC, 'app', '[locale]', 'members', 'page.tsx');
const PRODUCTS_PATH = join(SRC, 'app', '[locale]', 'financials', 'products', 'page.tsx');
const FILTER_BAR_PATH = join(SRC, 'components', 'FilterBar.tsx');
const LIST_CHROME_PATH = join(SRC, 'components', 'listChrome.ts');
const DATA_TABLE_PATH = join(SRC, 'components', 'DataTable.tsx');
const LOCALES_DIR = join(SRC, '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

/** The columns the list had before #928, in order (§3 keeps every one). */
const EXPECTED_COLUMNS = [
  'name',
  'email',
  'document',
  'payment_status',
  'enrollment_status',
  'actions',
] as const;

/** Their titles, which were already translated — #928 adds no column. */
const EXPECTED_COLUMN_LABELS = [
  'col_name',
  'col_email',
  'col_document',
  'col_payment_status',
  'col_enrollment_status',
  'col_actions',
] as const;

/** The five filters the ticket keeps, in the order the bar shows them. */
const EXPECTED_FILTERS = [
  'filter_search',
  'filter_document',
  'filter_center',
  'filter_payment_status',
  'filter_enrollment_status',
] as const;

/** The two labels the bar needed that the page did not have yet. */
const NEW_LOCALE_KEYS = ['filter_search', 'filter_document'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const pageSrc = stripComments(readFileSync(PAGE_PATH, 'utf-8'));
const productsSrc = stripComments(readFileSync(PRODUCTS_PATH, 'utf-8'));
const filterBarSrc = stripComments(readFileSync(FILTER_BAR_PATH, 'utf-8'));
const listChromeSrc = stripComments(readFileSync(LIST_CHROME_PATH, 'utf-8'));
const dataTableSrc = stripComments(readFileSync(DATA_TABLE_PATH, 'utf-8'));

/** The page header: the title and `+ Add Member` live here, nothing else. */
const pageHeaderSrc = pageSrc.match(
  /<div style=\{\{ display: 'flex', alignItems: 'center', justifyContent: 'space-between'[\s\S]*?\n {6}<\/div>\n/,
)?.[0] ?? '';

/** The filter bar. */
const filterBarUsageSrc = pageSrc.match(/<FilterBar>[\s\S]*?<\/FilterBar>/)?.[0] ?? '';

/** The collapsed row — one cell per LIST_COLUMNS entry. */
const collapsedRowSrc = pageSrc.match(
  /<div\n\s*style=\{headerRowStyle\}[\s\S]*?\n {8}<\/div>\n/,
)?.[0] ?? '';

const locales = Object.fromEntries(
  LOCALE_CODES.map((c) => [c, JSON.parse(readFileSync(join(LOCALES_DIR, `${c}.json`), 'utf-8'))]),
) as Record<(typeof LOCALE_CODES)[number], Record<string, Record<string, unknown>>>;

describe('Members list: one list with Products (#928)', () => {
  it('locates the three blocks it scans', () => {
    expect(pageHeaderSrc, 'the page header could not be located').not.toBe('');
    expect(filterBarUsageSrc, 'the filter bar could not be located').not.toBe('');
    expect(collapsedRowSrc, 'the collapsed row could not be located').not.toBe('');
  });

  // ── Columns ─────────────────────────────────────────────────────────────────

  it('declares every column once, in the order the list already had', () => {
    const declared = [...pageSrc.matchAll(/\{ key: '([a-z_]+)', labelKey: '(col_[a-z_]+)'/g)];
    expect(declared.map((m) => m[1])).toEqual([...EXPECTED_COLUMNS]);
    expect(declared.map((m) => m[2])).toEqual([...EXPECTED_COLUMN_LABELS]);
    // Exactly one flexible track: the name column absorbs the leftover width.
    expect([...pageSrc.matchAll(/grow: \d+/g)]).toHaveLength(1);
    expect(pageSrc).toMatch(/\{ key: 'name', labelKey: 'col_name', width: \d+, grow: \d+ \}/);
  });

  it('derives the grid template and the scroll threshold from that one list', () => {
    expect(pageSrc).toMatch(/const LIST_GRID_COLUMNS = LIST_COLUMNS\s*\n\s*\.map\(/);
    expect(pageSrc).toMatch(/const LIST_MIN_WIDTH =\s*\n\s*LIST_COLUMNS\.reduce\(/);
    // The rows' inset is the header's inset, from the shared chrome.
    expect(pageSrc).toMatch(/\+ LIST_PADDING_X \* 2/);
  });

  it('lays the header band and the rows out on the same grid', () => {
    expect(pageSrc).toMatch(/const listGridStyle: React\.CSSProperties = \{\s*\n\s*display: 'grid',\s*\n\s*gridTemplateColumns: LIST_GRID_COLUMNS,/);
    expect(pageSrc).toMatch(/const colHeaderStyle: React\.CSSProperties = \{\s*\n\s*\.\.\.listGridStyle, \.\.\.listHeaderRowStyle, \.\.\.listHeaderCellStyle,/);
    expect(pageSrc).toMatch(/const headerRowStyle: React\.CSSProperties = \{\s*\n\s*\.\.\.listGridStyle, \.\.\.listCellStyle,/);
    expect(pageSrc).toMatch(/LIST_COLUMNS\.map\(\(col\) => \(/);
  });

  it('renders the column titles from that list, not from a second one', () => {
    expect(pageSrc).toMatch(/\{t\(`members\.\$\{col\.labelKey\}`\)\}/);
    expect(pageSrc, 'the DataTable column list is still around').not.toMatch(/Column<Member>/);
    expect(pageSrc, 'the page still renders a DataTable').not.toMatch(/<DataTable/);
  });

  it('gives the collapsed row exactly one cell per column', () => {
    const cells = [...collapsedRowSrc.matchAll(
      /style=\{(?:cellStyle|nameCellStyle|mutedCellStyle|badgeCellStyle|actionsCellStyle)\}/g,
    )];
    expect(cells).toHaveLength(EXPECTED_COLUMNS.length);
    // The chevron and the ⋮ menu share the Actions cell, as on Products,
    // rather than sitting in tracks of their own.
    expect(collapsedRowSrc).toMatch(/style=\{actionsCellStyle\}[\s\S]*?<ContextMenu/);
  });

  it('keeps a long value inside its own column', () => {
    expect(pageSrc).toMatch(/const cellStyle: React\.CSSProperties = \{\s*\n\s*minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',/);
    // No cell may reintroduce a content-sized track of its own.
    expect(collapsedRowSrc).not.toMatch(/minWidth: \d/);
    expect(collapsedRowSrc).not.toMatch(/flexShrink/);
    expect(collapsedRowSrc).not.toMatch(/flex: \d/);
    // An ellipsised address stays readable.
    expect(collapsedRowSrc).toMatch(/title=\{m\.email\}/);
  });

  it('scrolls horizontally instead of dropping columns when the viewport is narrow', () => {
    const scroller = pageSrc.match(/<div style=\{\{ overflowX: 'auto' \}\}>[\s\S]*?\{members\.map\(renderRow\)\}/)?.[0] ?? '';
    expect(scroller, 'the rows are not inside the scrolling wrapper').not.toBe('');
    expect(scroller).toMatch(/minWidth: LIST_MIN_WIDTH/);
    // The header band scrolls with them, so the two cannot drift apart.
    expect(scroller).toMatch(/style=\{colHeaderStyle\}/);
  });

  // ── Chrome ──────────────────────────────────────────────────────────────────

  it('wears the list chrome DataTable is built from, not a copy of it', () => {
    for (const token of [
      'listCellStyle', 'listExpandedStyle', 'listHeaderCellStyle',
      'listHeaderRowStyle', 'listRowDividerStyle', 'listSurfaceStyle',
    ]) {
      expect(listChromeSrc, `listChrome does not export ${token}`).toMatch(new RegExp(`export const ${token}`));
      expect(dataTableSrc, `DataTable no longer uses ${token}`).toContain(token);
      expect(pageSrc, `the Members page does not use ${token}`).toContain(token);
    }
    // The header band's colour and the row divider live in one place only.
    expect(listChromeSrc).toMatch(/background: 'var\(--gd-app-bg, #f0f0f0\)'/);
    expect(listChromeSrc).toMatch(/borderTop: '1px solid var\(--gd-border, #e5e7eb\)'/);
    expect(pageSrc).not.toMatch(/background: 'var\(--gd-app-bg/);
    expect(pageSrc).not.toMatch(/var\(--gd-border/);
    // Header band and rows are one surface.
    expect(pageSrc).toMatch(/<div style=\{listSurfaceStyle\}>/);
    // The expanded body is the recessed surface an expanded DataTable row had.
    expect(pageSrc).toMatch(/<div style=\{listExpandedStyle\}>/);
  });

  it('is laid out the way the Products list is', () => {
    // Same three structural pieces, in the same shape, on both pages.
    for (const [label, pattern] of [
      ['a LIST_COLUMNS declaration', /const LIST_COLUMNS: ListColumn\[\] = \[/],
      ['a grid derived from it', /const LIST_GRID_COLUMNS = LIST_COLUMNS/],
      ['a scroll threshold derived from it', /const LIST_MIN_WIDTH =/],
      ['one shared grid style', /const listGridStyle: React\.CSSProperties = \{/],
      ['a scrolling wrapper', /overflowX: 'auto'/],
    ] as const) {
      expect(productsSrc, `Products no longer has ${label}`).toMatch(pattern);
      expect(pageSrc, `the Members list has no ${label}`).toMatch(pattern);
    }
    // And the same `+ Add` button: the shared helper, at the same colour —
    // which since #954 is the Theme's Primary Button rather than the lilac both
    // pages used to spell out, so the assertion moves with it.
    expect(productsSrc).toMatch(/from '@\/components\/ui'/);
    expect(pageSrc).toMatch(/import \{[^}]*\bprimaryBtnStyle\b[^}]*\} from '@\/components\/ui'/);
    expect(pageSrc, 'the page still carries its own copy of btnStyle').not.toMatch(/function btnStyle\(/);
    expect(pageHeaderSrc).toMatch(/style=\{primaryBtnStyle\(\)\}/);
  });

  // ── Filters ─────────────────────────────────────────────────────────────────

  it('renders every filter as a labelled field of the shared bar', () => {
    expect(pageSrc).toMatch(/import \{ FilterBar, FilterField, filterControlStyle \} from '@\/components\/FilterBar'/);
    const labelled = [...filterBarUsageSrc.matchAll(/<FilterField label=\{t\('members\.(filter_[a-z_]+)'\)\}/g)]
      .map((m) => m[1]);
    expect(labelled).toEqual([...EXPECTED_FILTERS]);
    // No filter was added or removed.
    expect([...pageSrc.matchAll(/<FilterField /g)]).toHaveLength(EXPECTED_FILTERS.length);
  });

  it('gives all five controls the same height, border and type size', () => {
    const controls = [...filterBarUsageSrc.matchAll(
      /style=\{(?:\{ \.\.\.filterControlStyle|filterControlStyle\})/g,
    )];
    expect(controls).toHaveLength(EXPECTED_FILTERS.length);
    expect(filterBarSrc).toMatch(/export const filterControlStyle: React\.CSSProperties = \{/);
    expect(filterBarSrc).toMatch(/export const filterLabelStyle: React\.CSSProperties = \{/);
    // Each control is reachable from its own label.
    for (const id of [
      'members-filter-search', 'members-filter-document', 'members-filter-center',
      'members-filter-payment-status', 'members-filter-enrollment-status',
    ]) {
      expect(filterBarUsageSrc, `${id} has no label of its own`).toContain(`htmlFor="${id}"`);
      expect(filterBarUsageSrc, `${id} is not on a control`).toContain(`id="${id}"`);
    }
  });

  it('moves the filters out of the page header and drops the old toolbar', () => {
    expect(pageHeaderSrc).not.toMatch(/FilterField|filterControlStyle|StatusFilter|type="search"/);
    expect(pageSrc, 'the old unlabelled toolbar row is still around')
      .not.toMatch(/\{\/\* Toolbar: search \+ filters \*\/\}/);
  });

  it('leaves what the filters actually do untouched', () => {
    for (const marker of [
      "p.set('centerId', centerFilter)",
      "p.set('q', searchQuery.trim())",
      "p.set('nif_nie_passport', documentFilter.trim())",
      "p.set('payment_status', paymentStatusFilter)",
      "p.set('enrollment_status', enrollmentStatusFilter)",
    ]) {
      expect(pageSrc, `the list query no longer sends ${marker}`).toContain(marker);
    }
    // Each filter still writes itself into the URL, and the Center filter is
    // still only offered to a gym that has more than one center.
    for (const handler of [
      'function handleCenterFilter', 'function handleSearch', 'function handleDocumentFilter',
      'function handlePaymentFilter', 'function handleEnrollmentFilter',
    ]) {
      expect(pageSrc, `${handler} is gone`).toContain(handler);
    }
    expect(filterBarUsageSrc).toMatch(/\{showCenters && \(/);
    expect(pageSrc).toMatch(/const showCenters = centers\.length > 1;/);
  });

  // ── Regression: the row, the actions and the expanded body ───────────────────

  it('keeps every value the row showed', () => {
    for (const marker of [
      '{m.name}',
      '{m.email}',
      "{m.nif_nie_passport || '—'}",
      'label={t(`members.payment_status_${m.payment_status}`)',
      'label={t(`members.enrollment_status_${m.enrollment_status}`)',
      "{t('members.payment_status_none')}",
      "{t('members.enrollment_status_none')}",
      '<ContextMenu',
    ]) {
      expect(collapsedRowSrc, `the row no longer renders ${marker}`).toContain(marker);
    }
  });

  it('keeps expand/collapse, the unsaved-changes guard and the actions', () => {
    // The whole row expands (Products' interaction), and it stays
    // keyboard-operable the way the chevron button it replaces was.
    expect(collapsedRowSrc).toMatch(/onClick=\{toggle\}/);
    expect(collapsedRowSrc).toMatch(/role="button"/);
    expect(collapsedRowSrc).toMatch(/tabIndex=\{0\}/);
    expect(collapsedRowSrc).toMatch(/aria-expanded=\{isExpanded\}/);
    expect(collapsedRowSrc).toMatch(/e\.key === 'Enter' \|\| e\.key === ' '/);
    // The chevron is decorative: the row carries the state, so it is not a
    // second control nested inside a `role="button"`.
    expect(collapsedRowSrc).toMatch(/aria-hidden="true" style=\{chevronStyle\(isExpanded\)\}/);
    // Acting on a member never also expands it.
    expect(collapsedRowSrc).toMatch(/onClick=\{\(e\) => e\.stopPropagation\(\)\}/);
    // Every entry point still goes through the unsaved-changes guard.
    expect(pageSrc).toMatch(/const toggle = \(\) => guardUnsaved\(\(\) => toggleExpand\(m\)\);/);
    expect(pageSrc).toMatch(/onClick=\{\(\) => guardUnsaved\(openAdd\)\}/);
    expect(pageSrc).toMatch(/function buildActions\(m: Member\): ContextMenuItem\[\]/);
    for (const action of [
      "t('members.action_invite')", "t('members.action_reinvite')", "t('members.action_revoke')",
      "t('members.edit')", "t('members.action_details')", "t('members.delete')",
    ]) {
      expect(pageSrc, `the ⋮ menu no longer offers ${action}`).toContain(action);
    }
  });

  it('keeps the expanded body, the inline Edit form and the Add modal', () => {
    expect(pageSrc).toMatch(/\{activeTab === 'profile' && editingId === m\.id && \(\s*\n\s*<MemberEditForm/);
    expect(pageSrc).toMatch(/<MemberExpandedRow\n\s*memberId=\{m\.id\}/);
    expect(pageSrc).toMatch(/editing=\{editingId === m\.id\}/);
    // #928 is UI-only: creation is still the modal it was (that is #805's shape
    // for other pages, not this ticket's).
    expect(pageSrc).toMatch(/\{t\('members\.modal_add'\)\}/);
    expect(pageSrc).toMatch(/<MemberDetailModal/);
    expect(pageSrc).toMatch(/<ConfirmDialog/);
  });

  it('still says when the list is loading and when it is empty', () => {
    expect(pageSrc).toMatch(/\{loading \? \(\s*\n\s*<p style=\{mutedTextStyle\}>\{t\('members\.loading'\)\}<\/p>/);
    expect(pageSrc).toMatch(/members\.length === 0 \? \(\s*\n\s*<p style=\{mutedTextStyle\}>\{t\('members\.empty'\)\}<\/p>/);
  });

  // ── Locales ─────────────────────────────────────────────────────────────────

  it('translates the two new filter labels, and every column title, in all locales', () => {
    for (const code of LOCALE_CODES) {
      const ns = locales[code].members;
      expect(ns, `${code}.json has no members namespace`).toBeTruthy();
      for (const key of [...NEW_LOCALE_KEYS, ...EXPECTED_FILTERS, ...EXPECTED_COLUMN_LABELS]) {
        expect(String(ns[key] ?? ''), `${code}.json is missing members.${key}`).not.toBe('');
      }
    }
  });
});
