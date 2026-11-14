// #2125 M6b-3 — the gate for retiring `user_memberships`. `plan_snapshots` is becoming the record of
// a Membership Plan assignment (Oscar's option A): M6b-1 gave it the identity and M6b-2 the
// lifecycle, and from this stage the readers move onto it group by group
// (`domain/planAssignments.ts`). This pins, per production file, how many SQL statements still name
// the `user_memberships` table (a `FROM`, `JOIN`, `UPDATE` or `INTO` of it; comments are not code).
//
// The list may only shrink: a file that moves its last statement is deleted from it, a file that
// moves some lowers its count, and a new reader or writer of the table fails the build. M6b-4 drops
// the table when the list is empty.

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

/** A file's lines with its comments dropped, so prose naming the table is not code. */
function code(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

const LEGACY_STATEMENT = /\b(?:FROM|JOIN|UPDATE|INTO)\s+user_memberships\b/g;
const statements = (source: string): number => (code(source).match(LEGACY_STATEMENT) ?? []).length;

/** The statements left on `user_memberships`, per file. Lower a count or delete a line; never raise one. */
const LEGACY_STATEMENTS: Record<string, number> = {
  'api/assigned-plan-snapshot.ts': 2,
  'api/assignment-commit.ts': 4,
  'api/assignment-config.ts': 2,
  'api/assignment-draft-set.ts': 3,
  'api/assignment-lifecycle.ts': 2,
  'api/billing-events.ts': 1,
  'api/billing-simulation.ts': 1,
  'api/card-updates.ts': 2,
  'api/entitlement-plan-links.ts': 1,
  'api/financials-dashboard.ts': 1,
  'api/home-dashboard.ts': 2,
  'api/me-billing-forecast.ts': 1,
  'api/me-membership-plans.ts': 1,
  'api/me-past-plan-details.ts': 1,
  'api/me-product-set-lines.ts': 1,
  'api/me.ts': 6,
  'api/member-membership-configuration.ts': 2,
  'api/membership-fee-pricing.ts': 1,
  'api/membership-plans.ts': 6,
  'api/membership-promotions.ts': 4,
  'api/new-member-eligibility.ts': 2,
  'api/one-active-plan.ts': 2,
  'api/one-per-member.ts': 2,
  'api/payment-page.ts': 1,
  'api/payment-requests.ts': 1,
  'api/payments.ts': 4,
  'api/plan-assignment-drift.ts': 3,
  'api/plan-assignment-lifecycle.ts': 1,
  'api/plan-assignment-sync.ts': 2,
  'api/plan-snapshot-sync.ts': 1,
  'api/product-set-bridge.ts': 2,
  'api/product-set-cancellation.ts': 2,
  'api/product-set-projection.ts': 8,
  'api/product-sets-router.ts': 2,
  'api/product-sets.ts': 3,
  'api/scheduled-event-execution.ts': 2,
  'api/user-membership-services.ts': 2,
  'api/user-memberships.ts': 29,
  'domain/billingEventPayments.ts': 3,
  'domain/memberEnrollment.ts': 1,
  'domain/memberProfessionalServices.ts': 1,
  'infra/audit-registry.ts': 1,
  'scripts/report-multi-active-memberships.ts': 3,
};

/** The access readers moved in M6b-3: none of them may name the table again. */
const MOVED = ['api/plan-class-types.ts', 'api/plan-center-access.ts'];

describe('user_memberships is being retired (#2125 M6b-3)', () => {
  it('no production file names the table in more statements than are pinned', () => {
    const found: Record<string, number> = {};
    for (const file of sourceFiles(API_SRC)) {
      const n = statements(readFileSync(file, 'utf8'));
      if (n > 0) found[file.slice(API_SRC.length + 1).split('\\').join('/')] = n;
    }
    expect(found).toEqual(LEGACY_STATEMENTS);
  });

  it('the access readers read the assignment from plan_snapshots', () => {
    for (const file of MOVED) {
      expect(LEGACY_STATEMENTS[file]).toBeUndefined();
      expect(readFileSync(join(API_SRC, file), 'utf8')).toContain('entitlingAssignmentSql(');
    }
    // The Members App schedule's access-locked flag asks the same predicate.
    expect(readFileSync(join(API_SRC, 'api/me.ts'), 'utf8')).toContain('entitlingAssignmentSql(');
  });

  it('M6b-4: the wallet\'s plan and Promotion sessions and the allowance renewals read plan_snapshots', () => {
    // The one statement left in the wallet is the Additional Services leg (the set's recurring lines).
    const wallet = readFileSync(join(API_SRC, 'domain/memberProfessionalServices.ts'), 'utf8');
    expect(wallet).toContain("entitlingAssignmentSql('pa')");
    expect(wallet).not.toContain('assignmentPlanSnapshotId(');
    for (const file of ['api/plan-allowance-renewals.ts', 'api/member-professional-services.ts']) {
      expect(LEGACY_STATEMENTS[file]).toBeUndefined();
      expect(readFileSync(join(API_SRC, file), 'utf8')).toContain('isCurrentAssignmentSnapshotSql(');
    }
  });

  it('M6b-5: the plans badge, the Duo partner check and Home\'s service task read plan_snapshots', () => {
    for (const file of ['api/duo-booking.ts', 'api/member-tab-counts.ts']) {
      expect(LEGACY_STATEMENTS[file]).toBeUndefined();
      const source = readFileSync(join(API_SRC, file), 'utf8');
      expect(source).toContain('isCurrentAssignmentSnapshotSql(');
      expect(source).toContain('assignmentCoversMemberSql(');
    }
    // The two statements left in Home are the plan-name lists of its member panels.
    const home = readFileSync(join(API_SRC, 'api/home-dashboard.ts'), 'utf8');
    expect(home).toContain("isCurrentAssignmentSnapshotSql('pa')");
    expect(home).not.toContain('assignmentPlanSnapshotId(');
  });

  it('counts a statement in code, across a line break, and ignores a comment and a look-alike table', () => {
    expect(statements("db.query('SELECT 1 FROM user_memberships um')")).toBe(1);
    expect(statements('`SELECT 1 FROM a\n   JOIN\n   user_memberships um ON 1`')).toBe(1);
    expect(statements("'UPDATE user_memberships SET x = 1'; 'INSERT INTO user_memberships (a)'")).toBe(2);
    expect(statements('// FROM user_memberships (history)')).toBe(0);
    expect(statements("'SELECT 1 FROM class_type_user_memberships'")).toBe(0);
    expect(statements("'SELECT 1 FROM user_memberships_archive'")).toBe(0);
  });
});
