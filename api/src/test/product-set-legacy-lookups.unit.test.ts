// #2125 M6b-41 — a lookup handed a legacy `user_memberships` id finds the Product Sets linked to it
// through the set's anchor (`product_sets.plan_assignment_id`, dual-written since M6b-36) with
// `productSetOfLegacyAssignmentSql()`, never by filtering `product_sets.user_membership_id`, the
// column the re-key drops. The gate fails the build if a production file filters a Product Set by
// that column again. Writers of the column (`SET user_membership_id = ?`) are the next sub-stage's.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { productSetOfLegacyAssignmentSql } from '../domain/planAssignments';

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

/**
 * A Product Set filtered by its legacy id: `FROM product_sets [alias] WHERE … user_membership_id = ?`
 * (or `IN (`), or a join condition `<alias>.user_membership_id = ?` on a `product_sets` alias.
 */
const UNALIASED_FILTER = /FROM product_sets(?:\s+\w+)?\s+WHERE[^`;]*?\buser_membership_id\s*(?:=\s*\?|IN\s*\()/;
const ALIASED_FILTER = /JOIN product_sets (\w+)[^`]*?\b\1\.user_membership_id\s*=\s*\?/;

describe('a Product Set is found by a legacy assignment id through its anchor (#2125 M6b-41)', () => {
  it('no production statement filters product_sets by user_membership_id', () => {
    const offenders = sourceFiles(API_SRC)
      .filter((f) => {
        const src = readFileSync(f, 'utf8');
        return UNALIASED_FILTER.test(src) || ALIASED_FILTER.test(src);
      })
      .map((f) => f.slice(API_SRC.length + 1));
    expect(offenders).toEqual([]);
  });

  it('the predicate asks the set\'s anchor, the lowest snapshot naming the legacy id', () => {
    const sql = productSetOfLegacyAssignmentSql('?', 'p');
    expect(sql).toContain('p.plan_assignment_id = (SELECT MIN(ps_anc.id) FROM plan_snapshots ps_anc');
    expect(sql).toContain('ps_anc.gym_id = p.gym_id');
    expect(sql).toContain('ps_anc.anchor_plan_snapshot_id = ?');
    expect(sql).not.toContain('p.user_membership_id');
  });

  it('the gate patterns catch the shapes it replaced', () => {
    expect(UNALIASED_FILTER.test("`SELECT id FROM product_sets WHERE gym_id = ? AND user_membership_id = ?`")).toBe(true);
    expect(UNALIASED_FILTER.test("`SELECT x FROM product_sets\n WHERE gym_id = ? AND status = 'active' AND user_membership_id IN (`")).toBe(true);
    expect(ALIASED_FILTER.test("`JOIN product_sets p ON p.id = j.product_set_id AND p.user_membership_id = ?`")).toBe(true);
    expect(UNALIASED_FILTER.test("`UPDATE product_sets SET user_membership_id = ? WHERE id = ?`")).toBe(false);
  });
});
