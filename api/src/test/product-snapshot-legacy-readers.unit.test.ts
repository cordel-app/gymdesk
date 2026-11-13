// #2126 stage 5d-6 — the gate that closes stage 5. The three legacy Product tables
// (`member_products_oneoff_snapshot`, `member_products_oneoff_promotion_snapshot`,
// `member_products_recurrent_snapshot`) are dropped by migration 415: stage 3 moved every reader to
// the Product snapshot tables (3v pinned what was left), stage 5d-5 stopped every writer, and the
// last reader (the `product-snapshots:validate` report) went with the tables. A purchase, its frozen
// Promotions and a recurring line live in `product_{session,oneoff,periodical}_snapshots` and
// `product_promotion_snapshots` only.
//
// So no production source may name one of the three in code (a comment recalling the history is
// fine): any statement naming one fails at runtime with ER_NO_SUCH_TABLE, which the global error
// handler turns into a bare 500. Migrations keep their own history and are not scanned; test
// fixtures that still speak the legacy shape go through `test/legacyProductFixture.ts`.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const API_SRC = join(__dirname, '..');

/** Every production `.ts` under api/src (tests and migrations excluded). */
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

/** A file's lines with its comments dropped, so prose naming a table is not code. */
function code(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

const LEGACY_TABLE =
  /\bmember_products_(?:recurrent_snapshot|oneoff_snapshot|oneoff_promotion_snapshot)\b/;

describe('the legacy Product tables are dropped (#2126 stage 5d-6)', () => {
  it('no production source names a legacy Product table in code', () => {
    const offenders = sourceFiles(API_SRC)
      .filter((file) => LEGACY_TABLE.test(code(readFileSync(file, 'utf8'))))
      .map((file) => file.slice(API_SRC.length + 1).split('\\').join('/'));
    expect(offenders).toEqual([]);
  });

  it('recognises a table name in code and ignores one in a comment', () => {
    expect(LEGACY_TABLE.test(code("db.query('DELETE FROM member_products_oneoff_snapshot WHERE id = ?')"))).toBe(true);
    expect(LEGACY_TABLE.test(code("const t = 'member_products_recurrent_snapshot';"))).toBe(true);
    expect(LEGACY_TABLE.test(code('// FROM member_products_oneoff_promotion_snapshot (history)'))).toBe(false);
    expect(LEGACY_TABLE.test(code('member_products_oneoff_snapshots_x'))).toBe(false);
  });
});
