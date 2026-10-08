import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

// #1011 — every column of an Admin list says what it is on a phone.
//
// A list row is a grid of inline-styled cells sized for a desktop window. The
// cells that cannot shrink win, the one that can — the name — is taken to zero,
// and the rest (the `⋮` with them) overflow off the right edge: that is the
// defect, and it is not Promotions-specific. The fix is one declaration per
// column (`Column.mobile`, read by `listChrome.ts`'s one stylesheet), which only
// works while *every* column carries one — a column that says nothing is a
// column the row has no room for, and the shape that broke was exactly a row
// whose cells had never been asked the question.
//
// This gate lives in the API suite for #1009's and #983's reason: CI runs
// `npm test` in `api/` only (the Admin job type-checks and builds), so a scan
// that has to hold on every push belongs here even when what it scans is a
// frontend. The Admin app's own suite
// (`apps/admin/src/test/list-mobile-columns.test.ts`) asserts what the
// mechanism *does*; this one asserts that no list opts out of it.

const ADMIN_SRC = join(__dirname, '..', '..', '..', 'apps', 'admin', 'src');

/** The vocabulary `listChrome.ts` declares. A fifth value goes there first. */
const MOBILE_VALUES = new Set(['name', 'keep', 'actions', 'secondary']);

function walk(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(full).isDirectory()) out.push(...walk(full, rel));
    else if (/\.tsx?$/.test(entry)) out.push(rel);
  }
  return out;
}

function withoutComments(relative: string): string {
  return readFileSync(join(ADMIN_SRC, relative), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

/**
 * A list declares its columns in one of two shapes, and both are scanned here:
 * `Column<T>[]`, which `DataTable` renders, and the `ListColumn[]` a page lays
 * its own CSS grid out from (#637 — Products, Members, Training Plans). The
 * per-column vocabulary is the same for both; what differs is only how the
 * cells are written, which is why the grid pages carry the `title` on the cell
 * itself rather than as an accessor in the declaration.
 */
type ColumnShape = 'table' | 'grid';

interface ColumnArray {
  shape: ColumnShape;
  src: string;
}

/** The source slice of a columns array literal, brackets balanced. */
function columnArrays(src: string): ColumnArray[] {
  const out: ColumnArray[] = [];
  const declaration = /:\s*(?:type\s+)?(Column<[^;]*?>|ListColumn)\[\]\s*=\s*\[/g;
  let match: RegExpExecArray | null;
  while ((match = declaration.exec(src)) !== null) {
    const shape: ColumnShape = match[1] === 'ListColumn' ? 'grid' : 'table';
    const open = match.index + match[0].length - 1;
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '[') depth++;
      else if (src[i] === ']') {
        depth--;
        if (depth === 0) { out.push({ shape, src: src.slice(open, i + 1) }); break; }
      }
    }
  }
  return out;
}

/** Every file that declares list columns, with those declarations. */
const declarations = walk(ADMIN_SRC)
  // DataTable itself declares the interface rather than any columns.
  .filter((rel) => rel !== 'components/DataTable.tsx' && !rel.startsWith('test/'))
  .map((rel) => ({ rel, arrays: columnArrays(withoutComments(rel)) }))
  .filter((entry) => entry.arrays.length > 0);

describe('#1011 — Admin list columns declare their mobile behaviour', () => {
  it('finds every list that declares columns', () => {
    // The twelve `DataTable` consumers of stage 1, the three grid pages of
    // stage 2 and the sixteen flex-row pages stages 3 and 4 converted into grid
    // pages. A thirty-second is welcome; a count that drops means a list
    // stopped declaring its columns the shared way.
    expect(declarations.length).toBeGreaterThanOrEqual(31);
    // Exact, because #1011's adoption is complete: every card list of the Admin
    // app lays its rows out from one declaration now, so a page that quietly
    // went back to hand-sized cells would drop this count. A new list that adopts
    // the declaration raises it: the twentieth is Cordel → Mobile builds (#1077).
    expect(declarations.flatMap((d) => d.arrays).filter((a) => a.shape === 'grid'))
      .toHaveLength(20);
  });

  it('gives every column a mobile behaviour', () => {
    for (const { rel, arrays } of declarations) {
      arrays.forEach(({ shape, src }, i) => {
        // A table column is a `header`; a grid column is a `key` (its header is
        // a locale key the page maps over). Either way there is one per column.
        const columns = src.match(shape === 'grid' ? /\bkey:/g : /\bheader:/g)?.length ?? 0;
        const mobiles = src.match(/\bmobile:/g)?.length ?? 0;
        expect(columns, `${rel} declaration ${i} has no columns`).toBeGreaterThan(0);
        expect(mobiles, `${rel} declaration ${i}: ${columns} columns but ${mobiles} mobile declarations`)
          .toBe(columns);
      });
    }
  });

  it('names exactly one column the row identity', () => {
    for (const { rel, arrays } of declarations) {
      arrays.forEach(({ src }, i) => {
        const names = src.match(/\bmobile:\s*'name'/g)?.length ?? 0;
        // One, never none (a row with no visible identity is the defect) and
        // never two (only one cell can be the pinned, truncated identifier).
        expect(names, `${rel} declaration ${i} declares ${names} name columns`).toBe(1);
      });
    }
  });

  it('declares only values listChrome knows', () => {
    for (const { rel, arrays } of declarations) {
      for (const value of arrays.map((a) => a.src).join('\n').matchAll(/\bmobile:\s*'([^']*)'/g)) {
        expect(MOBILE_VALUES.has(value[1]), `${rel} declares mobile: '${value[1]}'`).toBe(true);
      }
    }
  });

  it('keeps a `title` beside every name column, so a truncated name stays readable', () => {
    for (const { rel, arrays } of declarations) {
      arrays.forEach(({ shape, src }, i) => {
        if (shape === 'grid') {
          // A grid page writes its cells by hand, so the title sits on the name
          // cell itself rather than in the declaration — and the cell reaches
          // its column through the one class map.
          const page = withoutComments(rel);
          expect(page, `${rel} does not derive its cell classes from its columns`)
            .toContain('listCellClasses(LIST_COLUMNS)');
          expect(/className=\{CELL_CLASS\.[a-z_]+\}[^>]*title=\{/.test(page),
            `${rel} declaration ${i}: the name cell carries no title`).toBe(true);
          return;
        }
        expect(/\btitle:\s*\(/.test(src), `${rel} declaration ${i} has no title accessor`).toBe(true);
      });
    }
  });
});

describe('#1011 — the mobile rules are declared in one place', () => {
  const chrome = withoutComments('components/listChrome.ts');

  it('mirrors AppShell’s own breakpoint rather than declaring a second one', () => {
    const shell = withoutComments('components/AppShell.tsx');
    expect(shell).toContain('@media (max-width: 768px)');
    expect(chrome).toContain("export const LIST_MOBILE_MEDIA_QUERY = '(max-width: 768px)'");
  });

  it('is the only module that writes a list media query', () => {
    const offenders = walk(ADMIN_SRC)
      .filter((rel) => !rel.startsWith('test/'))
      .filter((rel) => rel !== 'components/listChrome.ts' && rel !== 'components/AppShell.tsx')
      .filter((rel) => /gd-list-/.test(withoutComments(rel)));
    // A page that spelled a cell class, or a media query of its own, would be the
    // second place deciding what a phone shows.
    expect(offenders).toEqual([]);
  });
});
