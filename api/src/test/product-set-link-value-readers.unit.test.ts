// #2125 M6b-42 — a reader that needs the value of a Product Set's link to its assignment (the legacy
// `user_memberships` id) reads it off the set's anchor with `productSetLegacyAssignmentIdSql()`, never
// `product_sets.user_membership_id`, the column the re-key drops. The readers left are pinned: the
// snapshot sync (which is what names a Draft's snapshot from the set's link, before an anchor exists),
// the projection (a writer of the link, moved with the writers), the drift report (which compares the
// two columns) and the beneficiaries fallback. The list may only shrink: since M6b-43 the projection
// and the beneficiaries fallback read the anchor too, leaving the snapshot sync and the drift report.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { productSetLegacyAssignmentIdSql } from '../domain/planAssignments';

const API_SRC = join(__dirname, '..');

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

const READ = /\b(?:ps|prev)\.user_membership_id\b/g;

const ALLOWED: Record<string, number> = {
  'api/plan-snapshot-sync.ts': 2,
  'api/plan-assignment-drift.ts': 2,
};

function readsOf(file: string): number {
  return readFileSync(file, 'utf8').split('\n')
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .reduce((n, line) => n + (line.match(READ)?.length ?? 0), 0);
}

describe('a Product Set link value is read through its anchor (#2125 M6b-42)', () => {
  it('only the pinned files read product_sets.user_membership_id', () => {
    const found: Record<string, number> = {};
    for (const f of sourceFiles(API_SRC)) {
      const n = readsOf(f);
      if (n > 0) found[f.slice(API_SRC.length + 1).replace(/\\/g, '/')] = n;
    }
    expect(found).toEqual(ALLOWED);
  });

  it('the helper reads the anchor snapshot\'s legacy id', () => {
    const sql = productSetLegacyAssignmentIdSql('p');
    expect(sql).toContain('ps_lid.id = p.plan_assignment_id');
    expect(sql).toContain('ps_lid.gym_id = p.gym_id');
    expect(sql).toContain('ps_lid.source_user_membership_id');
    expect(sql).not.toContain('p.user_membership_id');
  });
});
