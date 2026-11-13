// #2126 stage 3v — a gate that closes stage 3 ("move the readers to the Product snapshot tables").
//
// Stages 3a–3u moved every reader of a member's Product lines and purchases onto the Product
// snapshot tables (`product_{session,oneoff,periodical}_snapshots`, `product_promotion_snapshots`).
// What still reads the three legacy tables does so on purpose, and this file is the list of it:
//
//   - (until stage 5c-2c-2) the copies a new Product Set version took of the legacy lines; since then a
//     clone links its predecessor's lines and a merge copies them from their snapshots, so none is left.
//     Since stage 5c nothing re-derives a recurring line's snapshot from its legacy row (since 5b,
//     nothing a purchase's);
//   - the row locks taken on a legacy recurring line before it is written (`SELECT id … FOR UPDATE`);
//     a one-time purchase is locked on its snapshot since stage 5b (`lockPurchase()`);
//   - (until stage 5a) the purchase record joined only for its `payment_request_id`; since 5a a
//     purchase reaches its payment through `billing_event_{oneoff,session}_snapshots`, so none is left;
//   - the read-only `validate-product-snapshots.ts` report, which compares the two.
//
// The counts are exact, so a new `FROM`/`JOIN` of a legacy table fails the build until it is
// either moved to the snapshot tables or added here with its reason, and a reader that is moved
// away must lower its count. The list may only shrink; stage 5 empties it.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const API_SRC = join(__dirname, '..');

const LEGACY_READS: Record<string, { count: number; why: string }> = {
  'api/product-set-draft.ts': { count: 2, why: 'removeService() / setServiceQuantity() lock the legacy line they write' },
  'scripts/validate-product-snapshots.ts': { count: 10, why: 'read-only report comparing the legacy and snapshot tables' },
};

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

/** A file's lines with its comments dropped, so prose naming a table is not a read. */
function code(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

/** `FROM`/`JOIN` of a legacy table, except a `DELETE FROM`, which is a write. */
const LEGACY_READ =
  /(DELETE\s+)?\b(?:FROM|JOIN)\s+(?:member_products_recurrent_snapshot|member_products_oneoff_snapshot|member_products_oneoff_promotion_snapshot)\b/g;

function legacyReadCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of sourceFiles(API_SRC)) {
    let n = 0;
    for (const match of code(readFileSync(file, 'utf8')).matchAll(LEGACY_READ)) {
      if (!match[1]) n++;
    }
    if (n > 0) counts[file.slice(API_SRC.length + 1).split('\\').join('/')] = n;
  }
  return counts;
}

describe('legacy Product tables are read only where the list says (#2126 stage 3)', () => {
  it('matches the declared readers exactly', () => {
    const expected = Object.fromEntries(Object.entries(LEGACY_READS).map(([file, { count }]) => [file, count]));
    expect(legacyReadCounts()).toEqual(expected);
  });

  it('counts a read and ignores a delete and a comment', () => {
    const sample = code([
      '// FROM member_products_recurrent_snapshot (prose)',
      'DELETE FROM member_products_oneoff_snapshot WHERE id = ?',
      'SELECT id FROM member_products_oneoff_snapshot WHERE id = ?',
      'LEFT JOIN member_products_oneoff_promotion_snapshot p ON p.id = x.id',
    ].join('\n'));
    const reads = [...sample.matchAll(LEGACY_READ)].filter((m) => !m[1]);
    expect(reads).toHaveLength(2);
  });
});
