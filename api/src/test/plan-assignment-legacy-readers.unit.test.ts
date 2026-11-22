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
  // M6b-51c-3: every UPDATE of the table; M6b-51d-1: and its one INSERT, under a registry id;
  // M6b-51d-3: and its one DELETE, of Draft rows only.
  'api/assignment-lifecycle-writer.ts': 3,
  'api/plan-assignment-drift.ts': 5, // M6b-51c-4: the report compares the anchor's lifecycle with the legacy row
  'api/plan-assignment-sync.ts': 1, // M6b-51d-7a: only the anchor lifecycle's repair (`plan-assignments:settle`)
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

  it('M6b-51d-2: a writer locks and reads its assignment on the anchor snapshot', () => {
    // One assignment's lock (the multi-row conflict reads are the next stage's).
    const LOCK = /FROM\s+user_memberships\s+WHERE\s+id\s*=\s*\?[^`'"]*FOR UPDATE/;
    for (const file of ['api/assignment-commit.ts', 'api/product-set-projection.ts', 'api/user-memberships.ts']) {
      const source = code(readFileSync(join(API_SRC, file), 'utf8'));
      expect(source).toContain('lockAssignmentRecord(');
      expect(source).not.toMatch(LOCK);
      expect(source).not.toContain('lockAssignmentAnchor(');
    }
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
    const home = readFileSync(join(API_SRC, 'api/home-dashboard.ts'), 'utf8');
    expect(home).toContain("isCurrentAssignmentSnapshotSql('pa')");
    expect(home).not.toContain('assignmentPlanSnapshotId(');
  });

  it('M6b-8: Home\'s plan names, the Financials plan count and the card-removal check read plan_snapshots', () => {
    for (const file of ['api/home-dashboard.ts', 'api/financials-dashboard.ts']) {
      expect(LEGACY_STATEMENTS[file]).toBeUndefined();
      expect(readFileSync(join(API_SRC, file), 'utf8')).toContain("isCurrentAssignmentSnapshotSql('pa')");
    }
    // Since M6b-18 card-updates names no legacy statement at all (the assignment a card replacement is filed under moved too).
    expect(LEGACY_STATEMENTS['api/card-updates.ts']).toBeUndefined();
    expect(readFileSync(join(API_SRC, 'api/card-updates.ts'), 'utf8')).toContain("isCurrentAssignmentSnapshotSql('pa')");
  });

  it('M6b-18: the card replacement\'s assignment and the Members App Product Set view read plan_snapshots', () => {
    expect(LEGACY_STATEMENTS['api/card-updates.ts']).toBeUndefined();
    expect(readFileSync(join(API_SRC, 'api/card-updates.ts'), 'utf8')).toContain('FROM ${OWNED_ASSIGNMENT_ROWS_SQL} um');
    expect(LEGACY_STATEMENTS['api/me-product-set-lines.ts']).toBeUndefined();
    expect(readFileSync(join(API_SRC, 'api/me-product-set-lines.ts'), 'utf8')).toContain('LEFT JOIN ${GYM_ASSIGNMENT_ROWS_SQL} um');
  });

  it('M6b-9: the One per Member plan check and the Members App plan-choice check read plan_snapshots', () => {
    for (const file of ['api/one-per-member.ts', 'api/me-membership-plans.ts']) {
      expect(LEGACY_STATEMENTS[file]).toBeUndefined();
      const source = readFileSync(join(API_SRC, file), 'utf8');
      expect(source).toContain("isCurrentAssignmentSnapshotSql('pa')");
      expect(source).not.toContain('assignmentPlanSnapshotId(');
    }
    expect(readFileSync(join(API_SRC, 'api/me-membership-plans.ts'), 'utf8')).toContain("assignmentCoversMemberSql('pa')");
  });

  it('M6b-10: the readers handed an assignment id for its owner or plan read plan_snapshots', () => {
    for (const file of ['api/billing-events.ts', 'api/payment-page.ts', 'infra/audit-registry.ts']) {
      expect(LEGACY_STATEMENTS[file]).toBeUndefined();
      expect(readFileSync(join(API_SRC, file), 'utf8')).toContain('assignmentOfLegacyIdSql(');
    }
    // M6b-16 moved the two statements left in payments.ts (the assignment of a Billing Event).
    expect(readFileSync(join(API_SRC, 'api/payments.ts'), 'utf8')).toContain("assignmentOfLegacyIdSql('pr.user_membership_id')");
  });

  it('M6b-11: the past plans\' details read plan_snapshots and the #956 multi-plan report is retired', () => {
    expect(LEGACY_STATEMENTS['api/me-past-plan-details.ts']).toBeUndefined();
    // #2125 stage 3 allows several live plans per member, so the report of members holding more than one is gone.
    expect(() => statSync(join(API_SRC, 'scripts/report-multi-active-memberships.ts'))).toThrow();
    const pkg = readFileSync(join(API_SRC, '..', 'package.json'), 'utf8');
    expect(pkg).not.toContain('memberships:multi-active');
  });

  it('M6b-13: the New Member rule and the enrollment status read plan_snapshots', () => {
    for (const file of ['api/new-member-eligibility.ts', 'domain/memberEnrollment.ts']) {
      expect(LEGACY_STATEMENTS[file]).toBeUndefined();
      const source = readFileSync(join(API_SRC, file), 'utf8');
      expect(source).toContain('OWNED_ASSIGNMENTS_FROM_SQL');
      expect(source).toContain('OWNED_ASSIGNMENT_IS_CURRENT_SQL');
    }
  });

  it('M6b-14: the member\'s own plan history and the Payments forecast read plan_snapshots', () => {
    expect(LEGACY_STATEMENTS['api/me-billing-forecast.ts']).toBeUndefined();
    for (const file of ['api/me.ts', 'api/me-billing-forecast.ts']) {
      expect(readFileSync(join(API_SRC, file), 'utf8')).toContain('FROM ${OWNED_ASSIGNMENT_ROWS_SQL} um');
    }
  });

  it('M6b-15: the member\'s applied Promotions, Pay now and a staff payment request read plan_snapshots', () => {
    expect(LEGACY_STATEMENTS['api/payment-requests.ts']).toBeUndefined();
    expect(readFileSync(join(API_SRC, 'api/payment-requests.ts'), 'utf8')).toContain("assignmentOfLegacyIdSql('?', 'um')");
    const me = readFileSync(join(API_SRC, 'api/me.ts'), 'utf8');
    expect(me.split('FROM ${OWNED_ASSIGNMENT_ROWS_SQL} um').length - 1).toBeGreaterThanOrEqual(4);
  });

  it('M6b-16: the Billing Event readers and the member\'s payment history read plan_snapshots', () => {
    expect(LEGACY_STATEMENTS['api/payments.ts']).toBeUndefined();
    const payments = readFileSync(join(API_SRC, 'api/payments.ts'), 'utf8');
    expect(payments).toContain("assignmentOfLegacyIdSql(eventAssignmentSql(), 'ps_pa')");
    expect(payments).toContain('assignmentOfLegacyIdSql(eventAssignmentSql())');
    // The dunning pause's dual-write went to the one writer (M6b-51c-3).
    expect(LEGACY_STATEMENTS['domain/billingEventPayments.ts']).toBeUndefined();
    expect(readFileSync(join(API_SRC, 'domain/billingEventPayments.ts'), 'utf8')).toContain('assignmentOfLegacyIdSql(eventAssignmentSql())');
    // M6b-17 moved the one statement left in me.ts (`GET /me/membership`'s pending-payment plan read).
    expect(readFileSync(join(API_SRC, 'api/me.ts'), 'utf8')).toContain("assignmentOfLegacyIdSql('pr.user_membership_id')");
  });

  it('M6b-17: the pending-payment plan read and the Billing Simulation loader read plan_snapshots', () => {
    for (const file of ['api/me.ts', 'api/billing-simulation.ts']) expect(LEGACY_STATEMENTS[file]).toBeUndefined();
    const me = readFileSync(join(API_SRC, 'api/me.ts'), 'utf8');
    expect(me.split('FROM ${OWNED_ASSIGNMENT_ROWS_SQL} um').length - 1).toBe(4);
    expect(readFileSync(join(API_SRC, 'api/billing-simulation.ts'), 'utf8')).toContain('FROM ${GYM_ASSIGNMENT_ROWS_SQL} um');
  });

  it('M6b-19: the wallet\'s Additional Services leg and an assignment\'s services read plan_snapshots', () => {
    for (const file of ['domain/memberProfessionalServices.ts', 'api/user-membership-services.ts']) {
      expect(LEGACY_STATEMENTS[file]).toBeUndefined();
      expect(readFileSync(join(API_SRC, file), 'utf8')).toContain("isCurrentAssignmentSnapshotSql('pa')");
    }
    expect(readFileSync(join(API_SRC, 'api/user-membership-services.ts'), 'utf8')).toContain("assignmentOfLegacyIdSql('?', 'pa')");
  });

  it('M6b-20: the Membership Fee pricing loader and the configuration overlay read plan_snapshots', () => {
    expect(LEGACY_STATEMENTS['api/membership-fee-pricing.ts']).toBeUndefined();
    expect(readFileSync(join(API_SRC, 'api/membership-fee-pricing.ts'), 'utf8')).toContain('FROM ${GYM_ASSIGNMENT_ROWS_SQL} um');
    // M6b-26 moved the one statement left (`assignmentLineVersionId()`'s status read).
    expect(LEGACY_STATEMENTS['api/assignment-config.ts']).toBeUndefined();
    expect(readFileSync(join(API_SRC, 'api/assignment-config.ts'), 'utf8')).toContain('FROM ${GYM_ASSIGNMENT_ROWS_SQL} um');
  });

  it('counts a statement in code, across a line break, and ignores a comment and a look-alike table', () => {
    expect(statements("db.query('SELECT 1 FROM user_memberships um')")).toBe(1);
    expect(statements('`SELECT 1 FROM a\n   JOIN\n   user_memberships um ON 1`')).toBe(1);
    expect(statements("'UPDATE user_memberships SET x = 1'; 'INSERT INTO user_memberships (a)'")).toBe(2);
    expect(statements('// FROM user_memberships (history)')).toBe(0);
    expect(statements("'SELECT 1 FROM class_type_user_memberships'")).toBe(0);
    expect(statements("'SELECT 1 FROM user_memberships_archive'")).toBe(0);
  });

  it('M6b-21: the Assigned Plan snapshot reads and the Promotion routes\' status gates read plan_snapshots', () => {
    expect(LEGACY_STATEMENTS['api/assigned-plan-snapshot.ts']).toBeUndefined();
    const snapshot = readFileSync(join(API_SRC, 'api/assigned-plan-snapshot.ts'), 'utf8');
    expect(snapshot.split('FROM ${GYM_ASSIGNMENT_ROWS_SQL} um').length - 1).toBe(2);
    // The two statements left in membership-promotions.ts read inside a writing transaction or lock the row.
    const promotions = readFileSync(join(API_SRC, 'api/membership-promotions.ts'), 'utf8');
    expect(promotions.split('SELECT um.status FROM ${GYM_ASSIGNMENT_ROWS_SQL} um').length - 1).toBe(2);
  });
  it('M6b-22: the Membership Plan router\'s assignment counts read plan_snapshots', () => {
    // The bulk assign's INSERT, the last statement left there after M6b-29, went to the writer in M6b-51d-1.
    expect(LEGACY_STATEMENTS['api/membership-plans.ts']).toBeUndefined();
    const plans = readFileSync(join(API_SRC, 'api/membership-plans.ts'), 'utf8');
    expect(plans.split('FROM ${GYM_ASSIGNMENT_ROWS_SQL} um').length - 1).toBe(4);
    expect(plans).toContain("isCurrentAssignmentSnapshotSql('pa')");
  });

  it('M6b-29: the Plan reprice\'s candidate assignments read plan_snapshots', () => {
    const plans = readFileSync(join(API_SRC, 'api/membership-plans.ts'), 'utf8');
    expect(plans).toContain('FROM ${GYM_ASSIGNMENT_ROWS_SQL} um${ASSIGNMENT_CONFIG_JOIN()}');
  });

  it('M6b-26: an assignment\'s version-level lines are chosen by its plan snapshot\'s status', () => {
    expect(LEGACY_STATEMENTS['api/assignment-config.ts']).toBeUndefined();
    expect(readFileSync(join(API_SRC, 'api/assignment-config.ts'), 'utf8'))
      .toContain("assignmentOfAnchorSql('p9.plan_assignment_id', 'u9')");
  });

  it('M6b-27: the bridge\'s closed-assignment check and the cancellation start date read plan_snapshots', () => {
    expect(LEGACY_STATEMENTS['api/product-set-bridge.ts']).toBeUndefined();
    const bridge = readFileSync(join(API_SRC, 'api/product-set-bridge.ts'), 'utf8');
    expect(bridge).toContain("assignmentOfLegacyIdSql('?', 'pa')");
    expect(bridge).toContain("assignmentOfAnchorSql('ps.plan_assignment_id', 'pa')");
  });

  it('M6b-28: the projection\'s predecessor start date and the Product Sets list\'s end date read plan_snapshots', () => {
    expect(LEGACY_STATEMENTS['api/product-set-projection.ts']).toBeUndefined(); // M6b-51d-2 moved its locks
    expect(readFileSync(join(API_SRC, 'api/product-set-projection.ts'), 'utf8')).toContain("assignmentOfLegacyIdSql('?', 'pa')");
    expect(readFileSync(join(API_SRC, 'api/member-membership-configuration.ts'), 'utf8'))
      .toContain("assignmentOfAnchorSql('ps.plan_assignment_id', 'pa')");
  });

  it('M6b-31: the Member card\'s plan history reads plan_snapshots, creator and modifier included', () => {
    expect(LEGACY_STATEMENTS['api/member-membership-configuration.ts']).toBeUndefined();
    const config = readFileSync(join(API_SRC, 'api/member-membership-configuration.ts'), 'utf8');
    expect(config).toContain('FROM ${ASSIGNMENT_HISTORY_ROWS_SQL} um');
  });

  it('M6b-51c-3: an assignment is updated only by the one lifecycle writer', () => {
    const UPDATE = /\bUPDATE\s+user_memberships\b/g;
    const writers = sourceFiles(API_SRC)
      .filter((f) => (code(readFileSync(f, 'utf8')).match(UPDATE) ?? []).length > 0)
      .map((f) => f.slice(API_SRC.length + 1));
    expect(writers).toEqual(['api/assignment-lifecycle-writer.ts']);
  });

  it('M6b-51d-1: an assignment is created only by the writer, under a plan_assignment_ids id', () => {
    const INSERT = /\bINTO\s+user_memberships\b/g;
    const creators = sourceFiles(API_SRC)
      .filter((f) => (code(readFileSync(f, 'utf8')).match(INSERT) ?? []).length > 0)
      .map((f) => f.slice(API_SRC.length + 1));
    expect(creators).toEqual(['api/assignment-lifecycle-writer.ts']);
    const writer = readFileSync(join(API_SRC, 'api/assignment-lifecycle-writer.ts'), 'utf8');
    expect(writer).toContain('INSERT INTO plan_assignment_ids');
  });

  it('M6b-47: the end-of-period sweep and both dunning pauses pick their assignment from plan_snapshots', () => {
    const sweep = readFileSync(join(API_SRC, 'api/assignment-lifecycle.ts'), 'utf8');
    expect(sweep).toContain("isCurrentAssignmentSnapshotSql('pa')");
    expect(readFileSync(join(API_SRC, 'api/scheduled-event-execution.ts'), 'utf8'))
      .toContain("assignmentOfAnchorSql('ps.plan_assignment_id', 'pa')");
    expect(readFileSync(join(API_SRC, 'domain/billingEventPayments.ts'), 'utf8'))
      .toContain("assignmentOfLegacyIdSql('?', 'pa')");
    // The dual-write each kept, guarded on the status it moves away from, is the one writer's (M6b-51c-3).
    for (const file of ['api/assignment-lifecycle.ts', 'api/scheduled-event-execution.ts', 'domain/billingEventPayments.ts']) {
      expect(LEGACY_STATEMENTS[file]).toBeUndefined();
      expect(readFileSync(join(API_SRC, file), 'utf8')).toContain('writeAssignmentLifecycle(');
    }
  });

  it('M6b-48: the Save & Pay link sync and the Pending Payment cancel read the owner from plan_snapshots', () => {
    for (const file of ['api/product-sets-router.ts', 'api/product-set-cancellation.ts']) {
      expect(readFileSync(join(API_SRC, file), 'utf8')).toContain("assignmentOfLegacyIdSql('?', 'pa')");
      // The dual-write each kept is the one writer's (M6b-51c-3).
      expect(LEGACY_STATEMENTS[file]).toBeUndefined();
      expect(readFileSync(join(API_SRC, file), 'utf8')).toContain('writeAssignmentLifecycle(');
    }
  });

  it('M6b-49: the plans a Product Set carries for entitlement are read from plan_snapshots', () => {
    expect(LEGACY_STATEMENTS['api/entitlement-plan-links.ts']).toBeUndefined();
    const links = readFileSync(join(API_SRC, 'api/entitlement-plan-links.ts'), 'utf8');
    expect(links).toContain("isCurrentAssignmentSnapshotSql('pa')");
    // A plan the activation's projection has just cancelled is linked by the projection itself.
    expect(readFileSync(join(API_SRC, 'api/product-set-projection.ts'), 'utf8')).toContain('linkCancellingPlan(tx, gymId, productSetId, previousUmId)');
  });

  it('M6b-50: a Promotion apply reads the assignment from plan_snapshots', () => {
    expect(LEGACY_STATEMENTS['api/membership-promotions.ts']).toBeUndefined();
    expect(readFileSync(join(API_SRC, 'api/membership-promotions.ts'), 'utf8')).toContain("assignmentOfLegacyIdSql('?', 'pa')");
  });

  it('M6b-51d-3: the conflict reads lock the anchors and an assignment is deleted only by the writer', () => {
    for (const file of ['api/one-active-plan.ts', 'api/assignment-commit.ts']) {
      expect(LEGACY_STATEMENTS[file]).toBeUndefined();
      expect(readFileSync(join(API_SRC, file), 'utf8')).toContain('lockAssignmentsCovering(');
    }
    const DELETE = /\bDELETE\b[^`'"]*\bFROM\s+user_memberships\b/g;
    const deleters = sourceFiles(API_SRC)
      .filter((f) => (code(readFileSync(f, 'utf8')).match(DELETE) ?? []).length > 0)
      .map((f) => f.slice(API_SRC.length + 1));
    expect(deleters).toEqual(['api/assignment-lifecycle-writer.ts']);
    for (const file of ['api/user-memberships.ts', 'api/assignment-draft-set.ts', 'api/product-sets.ts']) {
      expect(LEGACY_STATEMENTS[file]).toBeUndefined();
      expect(readFileSync(join(API_SRC, file), 'utf8')).toContain('deleteDraftAssignments(');
    }
  });

  it('M6b-51d-4: a test asserts an assignment off its plan snapshots, never off the legacy row', () => {
    // A `FROM` / `JOIN` of the table in a test (a `DELETE FROM` is a fixture's clean-up, not a read).
    // The fixture machinery still reads the hand-written rows it translates; migration 297's test
    // checks what that migration did to the table itself; the source gates name it in assertions.
    const ALLOWED = new Set([
      'helpers.ts', 'assignmentIdFixture.ts', 'assignmentFixture.ts', 'cancelled-assignment-cleanup.test.ts',
      'plan-assignment-legacy-readers.unit.test.ts', 'member-enrollment.unit.test.ts',
      'draft-assignment-status.unit.test.ts',
    ]);
    const READ = /(?<!DELETE\s)\b(?:FROM|JOIN)\s+user_memberships\b/g;
    const testDir = join(API_SRC, 'test');
    const readers = readdirSync(testDir)
      .filter((f) => f.endsWith('.ts') && !ALLOWED.has(f))
      .filter((f) => (code(readFileSync(join(testDir, f), 'utf8')).match(READ) ?? []).length > 0);
    expect(readers).toEqual([]);
  });

  it('M6b-51d-5: a test writes an assignment only through the fixture door', () => {
    // Every `INSERT INTO` / `UPDATE` / `DELETE FROM user_memberships` a test spells is handed to
    // `testAssignmentWrite()` (or `legacyAssignmentQuery()`, which goes through it), so dropping the
    // table changes `assignmentFixture.ts` and no test file. A statement passed straight to
    // `db.query` / `tx.query` fails the build.
    const DOORS = new Set(['testAssignmentWrite', 'legacyAssignmentQuery']);
    const OWN = new Set(['assignmentFixture.ts', 'assignmentIdFixture.ts']);
    const CALL = /([\w.]+)\s*(?:<[^>()]*>)?\(\s*['"`]\s*(?:INSERT\s+(?:IGNORE\s+)?INTO|UPDATE|DELETE\s+FROM)\s+user_memberships\b/g;
    const testDir = join(API_SRC, 'test');
    const offenders: string[] = [];
    for (const f of readdirSync(testDir).filter((n) => n.endsWith('.ts') && !OWN.has(n))) {
      for (const m of code(readFileSync(join(testDir, f), 'utf8')).matchAll(CALL)) {
        if (!DOORS.has(m[1])) offenders.push(`${f}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
