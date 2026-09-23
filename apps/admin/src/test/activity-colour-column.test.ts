import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Regression test for #676 — the Activity colour in the card header.
//
// The colour used to be a bullet drawn inside the name cell of the collapsed
// header. The ticket's follow-up comment asks for that bullet to go and for the
// colour to become a column of its own, between the (truncated) description and
// "created by" — the same column order the Plans page uses.
//
// This repo has no component-test infra for apps/admin (see docs/architecture.md's
// TL;DR), so — like sellable-items-column-alignment.test.ts (#637) — this pins
// the structure down by scanning the page source and the locale files.

const PAGE_PATH = join(__dirname, '..', 'app', '[locale]', 'activity-types', 'page.tsx');
const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

// The collapsed header's columns, in the order the ticket asks for them.
const EXPECTED_COLUMNS = [
  'col_name',
  'col_description',
  'col_color',
  'col_created_by',
  'col_created_at',
  'col_status',
  'col_default_center',
  'col_default_trainer',
] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const pageSrc = stripComments(readFileSync(PAGE_PATH, 'utf-8'));

// The collapsed header: the clickable row that expands the card.
const collapsedRowSrc = pageSrc.match(
  /<div style=\{rowStyle\} onClick=\{\(\) => toggleExpand\(row\.id\)\}>[\s\S]*?\n {8}<\/div>\n/,
)?.[0] ?? '';

// The column header strip above the list.
const colHeaderSrc = pageSrc.match(/<div style=\{colHeaderStyle\}>[\s\S]*?<\/div>\n {8}\)\}/)?.[0] ?? '';

const locales = Object.fromEntries(
  LOCALE_CODES.map((c) => [c, JSON.parse(readFileSync(join(LOCALES_DIR, `${c}.json`), 'utf-8'))]),
) as Record<(typeof LOCALE_CODES)[number], Record<string, Record<string, unknown>>>;

describe('Activities: colour in the card header (#676)', () => {
  it('extracts the collapsed header and the column strip to scan', () => {
    expect(collapsedRowSrc, 'the collapsed header could not be located').not.toBe('');
    expect(colHeaderSrc, 'the column header strip could not be located').not.toBe('');
  });

  it('lists the column headers in the ticket\'s order', () => {
    const declared = [...colHeaderSrc.matchAll(/t\('(col_[a-z_]+)'\)/g)].map((m) => m[1]);
    expect(declared).toEqual([...EXPECTED_COLUMNS]);
  });

  it('no longer draws the colour bullet next to the name', () => {
    const nameCell = collapsedRowSrc.match(/<div style=\{\{ flex: 2, fontWeight: 600[\s\S]*?<\/div>/)?.[0] ?? '';
    expect(nameCell, 'the name cell could not be located').not.toBe('');
    expect(nameCell).toContain('{row.name}');
    expect(nameCell, 'the colour bullet is still inside the name cell').not.toContain('row.color');
    expect(collapsedRowSrc, 'a round colour bullet is still rendered').not.toContain("borderRadius: '50%'");
  });

  it('renders the colour as its own cell, between description and created by', () => {
    const descriptionAt = collapsedRowSrc.indexOf('{row.description');
    const colourAt = collapsedRowSrc.indexOf('row.color');
    const createdByAt = collapsedRowSrc.indexOf('{row.created_by_name');
    expect(descriptionAt, 'the description cell is missing').toBeGreaterThan(-1);
    expect(colourAt, 'the colour cell is missing').toBeGreaterThan(-1);
    expect(createdByAt, 'the created-by cell is missing').toBeGreaterThan(-1);
    expect(descriptionAt).toBeLessThan(colourAt);
    expect(colourAt).toBeLessThan(createdByAt);
  });

  it('uses the exact configured colour and shows nothing when there is none', () => {
    expect(collapsedRowSrc).toMatch(/background: row\.color/);
    // No fallback colour: the cell is a conditional on row.color with an em dash.
    expect(collapsedRowSrc).toMatch(/\{row\.color \? \(/);
    expect(collapsedRowSrc).not.toMatch(/row\.color \?\? '#/);
    expect(collapsedRowSrc).not.toMatch(/row\.color \|\| '#/);
  });

  it('truncates a long description instead of widening its column', () => {
    const descriptionCell = collapsedRowSrc.match(/<div style=\{\{ flex: 3[\s\S]*?<\/div>/)?.[0] ?? '';
    expect(descriptionCell, 'the description cell could not be located').not.toBe('');
    expect(descriptionCell).toContain("textOverflow: 'ellipsis'");
    expect(descriptionCell).toContain("whiteSpace: 'nowrap'");
    // The full text stays reachable on hover.
    expect(descriptionCell).toContain('title={row.description ?? undefined}');
  });

  it('keeps the editable Colour field in the edit form and the add row', () => {
    const colourInputs = [...pageSrc.matchAll(/type="color"/g)];
    expect(colourInputs, 'an editable colour input was removed').toHaveLength(2);
    expect(pageSrc).toContain('value={editForm.color ||');
    expect(pageSrc).toContain('value={inlineNew.color ||');
  });

  it('translates the two new column headers in every locale', () => {
    for (const code of LOCALE_CODES) {
      const ns = locales[code].activity_types;
      expect(ns, `${code}.json has no activity_types namespace`).toBeTruthy();
      for (const key of EXPECTED_COLUMNS) {
        expect(String(ns[key] ?? ''), `${code}.json is missing activity_types.${key}`).not.toBe('');
      }
    }
  });
});
