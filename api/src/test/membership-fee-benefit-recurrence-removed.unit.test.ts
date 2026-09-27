// #814 — the Membership Fee Benefit has no recurrence, on either side of the API.
//
// A source/migration scan rather than an integration test: the behavioural half
// (a PUT with no `quantity`/`frequency_interval`/`frequency_unit` succeeds, and
// neither GET nor PUT answers with them) lives in `promotions.test.ts`, which
// needs MySQL. What this file pins down is the shape — that the columns are
// dropped, that the two CHECKs constraining them go with them, and that no
// writer, reader or validator of the three fields is left behind — because that
// is what a well-meaning future edit would silently reintroduce.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..');
const MIGRATION = join(SRC, 'infra', 'migrations', '199_membership_fee_benefit_no_recurrence.js');

const read = (...parts: string[]) => readFileSync(join(SRC, ...parts), 'utf-8');

// Every comment in these files names the removed fields on purpose, so the scans
// run against code with comments stripped.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const RECURRENCE_FIELDS = ['quantity', 'frequency_interval', 'frequency_unit'] as const;

// Every statement in the API that touches `promotion_membership_fee_benefits`,
// with the surrounding SQL. A recurrence column can only come back through one
// of these.
function benefitStatements(src: string): string[] {
  const code = stripComments(src);
  const out: string[] = [];
  const table = 'promotion_membership_fee_benefits';
  for (let i = code.indexOf(table); i >= 0; i = code.indexOf(table, i + 1)) {
    // A generous window either side: the column list of an INSERT sits after the
    // table name, the projection of a SELECT before it.
    out.push(code.slice(Math.max(0, i - 400), i + 700));
  }
  return out;
}

describe('#814: no recurrence on the Membership Fee Benefit', () => {
  it('migration 199 drops the three columns', () => {
    const migration = readFileSync(MIGRATION, 'utf-8');
    const up = migration.slice(migration.indexOf('exports.up'), migration.indexOf('exports.down'));
    for (const column of RECURRENCE_FIELDS) {
      expect(up, `migration 199 does not drop "${column}"`).toContain(`'${column}'`);
    }
    expect(up).toContain('dropColumn');
  });

  it('migration 199 drops the two CHECKs that constrained them, and keeps chk_pmfb_action', () => {
    const migration = readFileSync(MIGRATION, 'utf-8');
    const up = migration.slice(migration.indexOf('exports.up'), migration.indexOf('exports.down'));
    // MySQL 8 refuses to drop a column a CHECK still references, so both must go
    // before the columns do.
    expect(up).toContain('DROP CHECK chk_pmfb_positive');
    expect(up).toContain('DROP CHECK chk_pmfb_frequency_unit');
    expect(up.indexOf('DROP CHECK')).toBeLessThan(up.indexOf('dropColumn'));
    // `action` survives, so its CHECK must not be collateral damage.
    expect(up).not.toContain('chk_pmfb_action');
  });

  it("migration 199's down() restores the columns and both CHECKs", () => {
    const migration = readFileSync(MIGRATION, 'utf-8');
    const down = migration.slice(migration.indexOf('exports.down'));
    for (const column of RECURRENCE_FIELDS) {
      expect(down, `down() does not restore "${column}"`).toContain(`'${column}'`);
    }
    expect(down).toContain('chk_pmfb_positive');
    expect(down).toContain('chk_pmfb_frequency_unit');
  });

  it('no statement against the benefit table names a recurrence column', () => {
    const files: [string, string][] = [
      ['api/promotion-details.ts', read('api', 'promotion-details.ts')],
      ['api/promotions.ts', read('api', 'promotions.ts')],
      ['api/membership-promotions.ts', read('api', 'membership-promotions.ts')],
    ];
    for (const [name, src] of files) {
      const statements = benefitStatements(src);
      expect(statements.length, `${name} no longer touches the benefit table`).toBeGreaterThan(0);
      for (const statement of statements) {
        for (const field of RECURRENCE_FIELDS) {
          expect(statement, `${name} still reads or writes "${field}" on the benefit`).not.toContain(field);
        }
      }
    }
  });

  it('the singleton PUT validates none of the three', () => {
    const code = stripComments(read('api', 'promotion-details.ts'));
    const start = code.indexOf('function validateMembershipFeeBenefit');
    expect(start).toBeGreaterThan(-1);
    const validator = code.slice(start, code.indexOf('\n}', start));
    for (const field of RECURRENCE_FIELDS) {
      expect(validator, `validateMembershipFeeBenefit still requires "${field}"`).not.toContain(field);
    }
    // The fields that remain configurable are still validated.
    expect(validator).toContain('duration_months');
    expect(validator).toContain('action');
    expect(validator).toContain('value');
  });

  it('the snapshot shape is the four fields the fee resolution reads', () => {
    const code = stripComments(read('api', 'membership-promotions.ts'));
    const start = code.indexOf('export interface SnapshotMembershipFeeBenefit');
    expect(start).toBeGreaterThan(-1);
    const shape = code.slice(start, code.indexOf('}', start));
    for (const field of RECURRENCE_FIELDS) {
      expect(shape, `SnapshotMembershipFeeBenefit still declares "${field}"`).not.toContain(field);
    }
    for (const field of ['enabled', 'action', 'value', 'duration_months']) {
      expect(shape, `SnapshotMembershipFeeBenefit lost "${field}"`).toContain(field);
    }
  });
});
