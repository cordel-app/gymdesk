// #2125 M6b-40 — "is this Product Set linked to an assignment" is asked of the set's anchor
// (`product_sets.plan_assignment_id`, dual-written with `user_membership_id` since M6b-36), never of
// `product_sets.user_membership_id`, the column the re-key drops. The gate fails the build if a
// production file tests a Product Set's `user_membership_id` for NULL again.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { awaitsStaffSetup } from '../domain/shoppingCart';
import { editableDraftSql } from '../api/editable-draft';

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

/** A NULL test of a Product Set's `user_membership_id` through its usual alias (`ps.`, `${ps}.`). */
const SET_LINK_CHECK = /(?:\bps|\$\{ps\})\.user_membership_id\s+IS\s+(?:NOT\s+)?NULL/;

describe('a Product Set\'s link to an assignment is read from its projects_assignment link (#2125 M6b-40, N3b)', () => {
  it('no production statement tests a Product Set\'s user_membership_id for NULL', () => {
    const offenders = sourceFiles(API_SRC)
      .filter((f) => SET_LINK_CHECK.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(API_SRC.length + 1));
    expect(offenders).toEqual([]);
  });

  it('adopting a plain Draft for an edit guards on its anchor', () => {
    const src = readFileSync(join(API_SRC, 'api/assignment-draft-set.ts'), 'utf8');
    expect(src).toContain("ps.status = 'in_cart' AND ${productSetAssignmentSql('ps')} IS NULL");
    expect(src).not.toMatch(/AND user_membership_id IS NULL/);
  });

  it('a plain Draft is one with no anchor', () => {
    const sql = editableDraftSql('ps');
    expect(sql).toContain('psa_j.product_set_id = ps.id AND psa_j.projects_assignment = 1) IS NULL');
    expect(sql).not.toContain('user_membership_id');
  });

  it('a Draft awaits staff setup when it is linked to an assignment', () => {
    expect(awaitsStaffSetup({ status: 'in_cart', linked_user_membership_id: 12 })).toBe(true);
    expect(awaitsStaffSetup({ status: 'in_cart', linked_user_membership_id: null })).toBe(false);
    expect(awaitsStaffSetup({ status: 'pending_payment', linked_user_membership_id: 12 })).toBe(false);
  });
});
