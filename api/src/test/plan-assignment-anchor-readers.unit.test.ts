// #2125 M6b-37 — a Product Set's readers find its assignment's current plan snapshot through the
// set's own anchor (`product_sets.plan_assignment_id`, `assignmentOfAnchorSql()`), never through
// `product_sets.user_membership_id` (the column the re-key drops). The gate fails the build if a
// production file asks `assignmentOfLegacyIdSql()` of a Product Set's `user_membership_id` again.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assignmentOfAnchorSql, isCurrentAssignmentSnapshotSql } from '../domain/planAssignments';
import { assignmentLineVersionId, assignmentVersionId } from '../api/assignment-config';

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

/** `assignmentOfLegacyIdSql('<alias>.user_membership_id'…)` where the alias is a Product Set's. */
const SET_LEGACY_LOOKUP = /assignmentOfLegacyIdSql\(\s*'(?:ps|p9|p|set|prev)\.user_membership_id'/;

describe('a Product Set finds its assignment through its projects_assignment link (#2125 M6b-37, N3b)', () => {
  it('no production file looks a Product Set\'s assignment up by its user_membership_id', () => {
    const offenders = sourceFiles(API_SRC)
      .filter((f) => SET_LEGACY_LOOKUP.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(API_SRC.length + 1));
    expect(offenders).toEqual([]);
  });

  it('the moved readers ask the anchor', () => {
    for (const [file, expr] of [
      ['api/product-set-bridge.ts', "assignmentOfAnchorSql(productSetAssignmentSql('ps'), 'pa')"],
      ['api/member-membership-configuration.ts', "assignmentOfAnchorSql(productSetAssignmentSql('ps'), 'pa')"],
      ['api/assignment-config.ts', "assignmentOfAnchorSql(productSetAssignmentSql('p9'), 'u9')"],
    ] as const) {
      expect(readFileSync(join(API_SRC, file), 'utf8')).toContain(expr);
    }
  });

  it('matches the current snapshot of the assignment the anchor names', () => {
    expect(assignmentOfAnchorSql('x.anchor', 'pa'))
      .toBe(`(pa.anchor_plan_snapshot_id = x.anchor AND ${isCurrentAssignmentSnapshotSql('pa')})`);
  });

  // #2125 M6b-39 — the version an assignment is read from is picked by the set's anchor too.
  it('assignmentVersionId() and assignmentLineVersionId() pick the set by its anchor', () => {
    for (const sql of [assignmentVersionId('?'), assignmentLineVersionId('?')]) {
      expect(sql).not.toMatch(/p9\.user_membership_id/);
      expect(sql).toContain('psa_j.product_set_id = p9.id AND psa_j.projects_assignment = 1');
      expect(sql).toMatch(/\.anchor_plan_snapshot_id = \?/);
    }
  });
});
