// #2126 stage 5c-2a — a Product Set's recurring lines are read through `product_set_periodical_snapshots`.
//
// Stage 5c-2 links an unchanged recurring line across Product Set versions instead of copying it (as
// #2125 M4b did for plan snapshots), so one `product_periodical_snapshots` row will belong to several
// sets and its own `product_set_id` column will only name the set that created it. Before any line is
// shared, every reader asks the junction which lines a set holds (`lnk.product_set_id = ?`), never the
// snapshot's column. This gate fails the build when a statement naming `product_periodical_snapshots`
// filters or joins on that column outside the files that still write it.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const API_SRC = join(__dirname, '..');

/** The writers of the column (and the read-only comparison report), which keep it until 5d. */
const WRITERS = new Set([
  'api/recurring-line-writer.ts',
  'api/product-snapshot-sync.ts',
  'api/snapshot-junction-sync.ts',
  'scripts/validate-product-snapshots.ts',
]);

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'test' || entry === 'migrations') continue;
      sourceFiles(full, found);
    } else if (entry.endsWith('.ts')) {
      found.push(full);
    }
  }
  return found;
}

/** The SQL strings of a file (template and quoted literals) that name the recurring line snapshot table. */
function statements(source: string): string[] {
  const literals = source.match(/`[^`]*`|'[^'\n]*'/g) ?? [];
  return literals.filter((s) => /\bproduct_periodical_snapshots\b/.test(s));
}

/** Whether a statement reads the snapshot's own `product_set_id` (through its alias, or unqualified). */
function readsSetColumn(sql: string): boolean {
  const aliases = [...sql.matchAll(/\bproduct_periodical_snapshots\s+(?:AS\s+)?(\w+)/gi)]
    .map((m) => m[1])
    .filter((a) => !/^(ON|WHERE|JOIN|LEFT|SET|ORDER|GROUP|LIMIT)$/i.test(a));
  if (aliases.some((a) => new RegExp(`\\b${a}\\.product_set_id\\b`).test(sql))) return true;
  // Unaliased: `FROM product_periodical_snapshots WHERE … product_set_id = ?` with no junction in the statement.
  return aliases.length === 0 && !/product_set_periodical_snapshots/.test(sql)
    && /(?<![.\w])product_set_id\b/.test(sql);
}

describe('recurring lines are read through the Product Set junction (#2126 stage 5c-2a)', () => {
  it('no reader filters product_periodical_snapshots on its own product_set_id', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(API_SRC)) {
      const rel = file.slice(API_SRC.length + 1).split('\\').join('/');
      if (WRITERS.has(rel)) continue;
      for (const sql of statements(readFileSync(file, 'utf8'))) {
        if (readsSetColumn(sql)) offenders.push(`${rel}: ${sql.replace(/\s+/g, ' ').slice(0, 140)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('recognises an offending statement', () => {
    expect(readsSetColumn('`SELECT 1 FROM product_periodical_snapshots s WHERE s.product_set_id = ?`')).toBe(true);
    expect(readsSetColumn("'SELECT 1 FROM product_periodical_snapshots WHERE source_id = ? AND product_set_id = ?'")).toBe(true);
    expect(readsSetColumn(
      '`SELECT 1 FROM product_set_periodical_snapshots lnk JOIN product_periodical_snapshots s ON s.id = lnk.product_periodical_snapshot_id WHERE lnk.product_set_id = ?`',
    )).toBe(false);
  });
});
