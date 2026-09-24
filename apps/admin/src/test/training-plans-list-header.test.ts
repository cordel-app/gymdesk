import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #724 — Training Plans' filters and list header adopt Assigned Plans' pattern.
//
// Two things were wrong. The five filters sat unlabelled in the page header next
// to the title and the `+ New Training Plan` button, so the screen read as a
// page-level toolbar rather than a filtered list. And the column titles were a
// naked row of small sort buttons whose widths had nothing to do with the cells
// underneath them, so no title lined up with its values.
//
// The fix reuses what Assigned Plans already has: `FilterBar`/`FilterField` for
// "label above the control", and `listChrome` — the surface, header band, cell
// insets and dividers `DataTable` itself is built from — for the list. Header and
// rows then share one grid derived from LIST_COLUMNS, as Sellable Items does
// (#637), and scroll together when the viewport is too narrow.
//
// This repo has no component-test infra for apps/admin (see docs/architecture.md's
// TL;DR), so — like sellable-items-column-alignment.test.ts (#637) — this pins the
// structure down by scanning the sources and the locale files.

const SRC = join(__dirname, '..');
const PAGE_PATH = join(SRC, 'app', '[locale]', 'training-plans', 'page.tsx');
const ASSIGNED_PLANS_PATH = join(SRC, 'app', '[locale]', 'financials', 'assigned-plans', 'page.tsx');
const FILTER_BAR_PATH = join(SRC, 'components', 'FilterBar.tsx');
const LIST_CHROME_PATH = join(SRC, 'components', 'listChrome.ts');
const DATA_TABLE_PATH = join(SRC, 'components', 'DataTable.tsx');
const LOCALES_DIR = join(SRC, '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

/** The columns the page had before #724, in order, plus its two chrome tracks. */
const EXPECTED_COLUMNS = [
  'expand',
  'name',
  'status',
  'start_date',
  'created_at',
  'modified_at',
  'actions',
] as const;

/** The filters the ticket keeps: label key → the label the bar shows. */
const EXPECTED_FILTERS = [
  'filter_label_name',
  'filter_label_member',
  'filter_label_source',
  'filter_label_author',
  'filter_label_status',
] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const pageSrc = stripComments(readFileSync(PAGE_PATH, 'utf-8'));
const assignedPlansSrc = stripComments(readFileSync(ASSIGNED_PLANS_PATH, 'utf-8'));
const filterBarSrc = stripComments(readFileSync(FILTER_BAR_PATH, 'utf-8'));
const listChromeSrc = stripComments(readFileSync(LIST_CHROME_PATH, 'utf-8'));
const dataTableSrc = stripComments(readFileSync(DATA_TABLE_PATH, 'utf-8'));

/** The page header: the title and the New Training Plan button live here. */
const pageHeaderSrc = pageSrc.match(
  /<div style=\{\{ display: 'flex', alignItems: 'center', justifyContent: 'space-between'[\s\S]*?\n {6}<\/div>\n/,
)?.[0] ?? '';

/** The filter bar. */
const filterBarUsageSrc = pageSrc.match(/<FilterBar>[\s\S]*?<\/FilterBar>/)?.[0] ?? '';

/** The collapsed row — one cell per LIST_COLUMNS entry. */
const collapsedRowSrc = pageSrc.match(
  /<div onClick=\{onToggleExpand\} style=\{headerRowStyle\}[\s\S]*?\n {8}<\/div>\n/,
)?.[0] ?? '';

const locales = Object.fromEntries(
  LOCALE_CODES.map((c) => [c, JSON.parse(readFileSync(join(LOCALES_DIR, `${c}.json`), 'utf-8'))]),
) as Record<(typeof LOCALE_CODES)[number], Record<string, Record<string, unknown>>>;

describe('Training Plans: filters and list header (#724)', () => {
  it('locates the three blocks it scans', () => {
    expect(pageHeaderSrc, 'the page header could not be located').not.toBe('');
    expect(filterBarUsageSrc, 'the filter bar could not be located').not.toBe('');
    expect(collapsedRowSrc, 'the collapsed row could not be located').not.toBe('');
  });

  // ── Filters ─────────────────────────────────────────────────────────────────

  it('renders every filter as a labelled field of the shared bar', () => {
    expect(pageSrc).toMatch(/import \{ FilterBar, FilterField, filterControlStyle \} from '@\/components\/FilterBar'/);
    const labelled = [...filterBarUsageSrc.matchAll(/<FilterField label=\{t\('training_plans\.(filter_label_[a-z]+)'\)\}/g)]
      .map((m) => m[1]);
    expect(labelled).toEqual([...EXPECTED_FILTERS]);
  });

  it('gives all five controls the same height, border and type size', () => {
    // Four inline controls plus the StatusFilter, which takes the same style.
    const controls = [...filterBarUsageSrc.matchAll(/style=\{(?:\{ )?\.\.\.filterControlStyle|style=\{filterControlStyle\}/g)];
    expect(controls).toHaveLength(EXPECTED_FILTERS.length);
    expect(filterBarUsageSrc).toMatch(/<StatusFilter[\s\S]*?style=\{filterControlStyle\}/);
    expect(filterBarSrc).toMatch(/export const filterControlStyle: React\.CSSProperties = \{/);
    expect(filterBarSrc).toMatch(/export const filterLabelStyle: React\.CSSProperties = \{/);
  });

  it('is the same bar Assigned Plans renders, so the two cannot drift', () => {
    expect(assignedPlansSrc).toMatch(/from '@\/components\/FilterBar'/);
    expect(assignedPlansSrc).toMatch(/<FilterBar>/);
    expect(assignedPlansSrc).toMatch(/<FilterField label=\{t\('assigned_plans_page\.filter_status'\)\}>/);
    // The bar itself decides the layout: horizontal, wrapping, labels on top.
    expect(filterBarSrc).toMatch(/display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 16, alignItems: 'flex-end'/);
    expect(filterBarSrc).toMatch(/<label htmlFor=\{htmlFor\} style=\{filterLabelStyle\}>/);
  });

  it('leaves what the filters actually do untouched', () => {
    for (const param of [
      "params.set('status', statusFilter)",
      "params.set('name', nameQuery)",
      "params.set('member_id', memberFilter)",
      "params.set('template_id', templateFilter)",
      "params.set('created_by', createdByFilter)",
    ]) {
      expect(pageSrc, `the list query no longer sends ${param}`).toContain(param);
    }
    // Name search still debounces, and any filter change still resets the page.
    expect(pageSrc).toMatch(/setTimeout\(\(\) => setNameQuery\(nameInput\.trim\(\)\), 300\)/);
    expect(pageSrc).toMatch(/useEffect\(\(\) => \{ setOffset\(0\); \}, \[statusFilter, nameQuery, memberFilter, templateFilter, createdByFilter/);
    // No filter was added or removed.
    expect([...pageSrc.matchAll(/<FilterField /g)]).toHaveLength(EXPECTED_FILTERS.length);
  });

  it('moves the filters out of the page header and drops the old unlabelled row', () => {
    expect(pageHeaderSrc).not.toMatch(/FilterField|filterControlStyle|StatusFilter/);
    expect(pageSrc, 'the old page-header filter style is still around').not.toMatch(/filterInputStyle/);
  });

  // ── List header ─────────────────────────────────────────────────────────────

  it('declares every column once, in the order the page already had', () => {
    const declared = [...pageSrc.matchAll(/\{ key: '([a-z_]+)'/g)].map((m) => m[1]);
    expect(declared).toEqual([...EXPECTED_COLUMNS]);
    // Exactly one flexible track: the name column absorbs the leftover width.
    expect([...pageSrc.matchAll(/grow: \d+/g)]).toHaveLength(1);
    expect(pageSrc).toMatch(/\{ key: 'name', labelKey: 'col_name', sortKey: 'name', width: \d+, grow: \d+ \}/);
  });

  it('derives the grid template and the scroll threshold from that one list', () => {
    expect(pageSrc).toMatch(/const LIST_GRID_COLUMNS = LIST_COLUMNS\s*\n\s*\.map\(/);
    expect(pageSrc).toMatch(/const LIST_MIN_WIDTH =\s*\n\s*LIST_COLUMNS\.reduce\(/);
    // The rows' inset is the header's inset, from the shared chrome.
    expect(pageSrc).toMatch(/\+ LIST_PADDING_X \* 2/);
  });

  it('lays the header and the rows out on the same grid', () => {
    expect(pageSrc).toMatch(/const listGridStyle: React\.CSSProperties = \{\s*\n\s*display: 'grid',\s*\n\s*gridTemplateColumns: LIST_GRID_COLUMNS,/);
    expect(pageSrc).toMatch(/const colHeaderStyle: React\.CSSProperties = \{\s*\n\s*\.\.\.listGridStyle,/);
    expect(pageSrc).toMatch(/const headerRowStyle: React\.CSSProperties = \{\s*\n\s*\.\.\.listGridStyle,/);
    expect(pageSrc).toMatch(/LIST_COLUMNS\.map\(\(col\) => \(/);
  });

  it('wears the list chrome DataTable is built from, not a copy of it', () => {
    for (const token of [
      'listCellStyle', 'listExpandedStyle', 'listHeaderCellStyle',
      'listHeaderRowStyle', 'listRowDividerStyle', 'listSurfaceStyle',
    ]) {
      expect(listChromeSrc, `listChrome does not export ${token}`).toMatch(new RegExp(`export const ${token}`));
      expect(dataTableSrc, `DataTable no longer uses ${token}`).toContain(token);
      expect(pageSrc, `Training Plans no longer uses ${token}`).toContain(token);
    }
    // The header band's colour and the row divider live in one place only.
    expect(listChromeSrc).toMatch(/background: 'var\(--gd-app-bg, #f0f0f0\)'/);
    expect(listChromeSrc).toMatch(/borderTop: '1px solid var\(--gd-border, #e5e7eb\)'/);
    expect(pageSrc).not.toMatch(/background: 'var\(--gd-app-bg/);
    expect(pageSrc).not.toMatch(/var\(--gd-border/);
    // Header band and rows are one surface, as in the ticket's diagram.
    expect(pageSrc).toMatch(/<div style=\{listSurfaceStyle\}>/);
    expect(pageSrc).toMatch(/const colHeaderStyle: React\.CSSProperties = \{\s*\n\s*\.\.\.listGridStyle, \.\.\.listHeaderRowStyle, \.\.\.listHeaderCellStyle,/);
  });

  it('gives the collapsed row exactly one cell per column', () => {
    const cells = [...collapsedRowSrc.matchAll(/style=\{(?:\{ \.\.\.cellStyle|cellStyle|badgeCellStyle|actionsCellStyle)/g)];
    expect(cells).toHaveLength(EXPECTED_COLUMNS.length);
  });

  it('keeps a long value inside its own column', () => {
    expect(pageSrc).toMatch(/const cellStyle: React\.CSSProperties = \{\s*\n\s*minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',/);
    // No cell may reintroduce a content-sized track of its own.
    expect(collapsedRowSrc).not.toMatch(/flexShrink/);
    expect(collapsedRowSrc).not.toMatch(/maxWidth/);
    expect(collapsedRowSrc).not.toMatch(/flex: \d/);
  });

  it('scrolls horizontally instead of dropping columns when the viewport is narrow', () => {
    const scroller = pageSrc.match(/<div style=\{\{ overflowX: 'auto' \}\}>[\s\S]*?\{rows\.map\(\(row\) => \(/)?.[0] ?? '';
    expect(scroller, 'the rows are not inside the scrolling wrapper').not.toBe('');
    expect(scroller).toMatch(/minWidth: LIST_MIN_WIDTH/);
    // The headers scroll with them, so they cannot drift apart.
    expect(scroller).toMatch(/style=\{colHeaderStyle\}/);
  });

  it('sorts by exactly the keys it sorted by before', () => {
    const sortable = [...pageSrc.matchAll(/sortKey: '([a-z_]+)'/g)].map((m) => m[1]);
    expect(sortable).toEqual(['name', 'status', 'start_date', 'created_at', 'modified_at']);
    expect(pageSrc).toMatch(/sortBtn\(col\.sortKey, t\(`training_plans\.\$\{col\.labelKey\}`\)\)/);
    expect(pageSrc).toMatch(/function toggleSort\(key: SortKey\)/);
  });

  // ── Regression ──────────────────────────────────────────────────────────────

  it('leaves the page title and the New Training Plan button where they were', () => {
    expect(pageHeaderSrc).toMatch(/<h1 style=\{\{ margin: 0 \}\}>\{t\('training_plans\.title'\)\}<\/h1>/);
    expect(pageHeaderSrc).toMatch(/\{t\('training_plans\.new_plan'\)\}/);
    expect(pageHeaderSrc).toMatch(/style=\{readOnlyStyle\(btnStyle\(\), !canWrite\)\}/);
    expect(pageHeaderSrc).toMatch(/marginBottom: 24/);
  });

  it('keeps every value the row showed, and the row actions', () => {
    for (const marker of [
      '{row.name}',
      '{row.member_name}',
      '{row.description ?',
      'label={t(`status.${row.status}`)}',
      'formatDate(row.start_date, locale)',
      'formatDate(row.end_date, locale)',
      'formatDate(row.created_at, locale)',
      'formatDate(row.modified_at, locale)',
      '<ContextMenu',
    ]) {
      expect(collapsedRowSrc, `the row no longer renders ${marker}`).toContain(marker);
    }
    // Expand/collapse and the unsaved-changes guard are untouched.
    expect(collapsedRowSrc).toMatch(/onClick=\{onToggleExpand\}/);
    expect(collapsedRowSrc).toMatch(/\{expanded \? '▼' : '▶'\}/);
    expect(collapsedRowSrc).toMatch(/onClick=\{\(e\) => e\.stopPropagation\(\)\}/);
    expect(pageSrc).toMatch(/onToggleExpand=\{\(\) => guardUnsaved\(\(\) => toggleExpand\(row\)\)\}/);
    // Inline edit still replaces the row, and still says it is being edited.
    expect(pageSrc).toMatch(/const rowContainerStyle = \(editing: boolean\)/);
    expect(pageSrc).toMatch(/boxShadow: 'inset 3px 0 0 #4b45c6'/);
    // The Details view still offers View Audit Log (CLAUDE.md).
    expect(pageSrc).toMatch(/<ViewAuditLogButton entityType="training_plan" entityId=\{plan\.id\}/);
  });

  it('translates every filter label in all locales', () => {
    for (const code of LOCALE_CODES) {
      const ns = locales[code].training_plans;
      expect(ns, `${code}.json has no training_plans namespace`).toBeTruthy();
      for (const key of EXPECTED_FILTERS) {
        expect(String(ns[key] ?? ''), `${code}.json is missing training_plans.${key}`).not.toBe('');
      }
      // The column titles the header reuses were already there.
      for (const key of ['col_name', 'col_status', 'col_start_date', 'col_created_at', 'col_modified_at']) {
        expect(String(ns[key] ?? ''), `${code}.json is missing training_plans.${key}`).not.toBe('');
      }
    }
  });
});
