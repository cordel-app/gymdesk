import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// #1695 — the lifecycle dates of an assigned Membership Plan. Source-level gate
// (no MySQL): every writer that makes an assignment active stamps `purchased_at`
// once, and every writer that cancels one stamps `closed_at` without overwriting.
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

describe('assignment lifecycle dates (#1695)', () => {
  it('commit and projection stamp purchased_at once', () => {
    expect(read('api/assignment-commit.ts')).toMatch(/purchased_at = COALESCE\(purchased_at, UTC_TIMESTAMP\(\)\)/);
    const proj = read('api/product-set-projection.ts');
    expect(proj).toMatch(/purchased_at = IF\(status IN \('cancelled','expired','superseded'\), purchased_at, COALESCE\(purchased_at, UTC_TIMESTAMP\(\)\)\)/);
    expect(proj).toMatch(/purchased_at, created_by\)\s+VALUES \(\?, \?, \?, \?, \?, 'active', COALESCE\(\(SELECT um0\.purchased_at FROM user_memberships um0 WHERE um0\.id = \? AND um0\.gym_id = \?\), UTC_TIMESTAMP\(\)\), \?\)/);
  });

  it('every cancelling UPDATE keeps the first closed_at', () => {
    for (const f of ['api/user-memberships.ts', 'api/product-set-projection.ts', 'api/one-active-plan.ts']) {
      const src = read(f);
      expect(src).not.toMatch(/status = 'cancelled', closed_at = UTC_TIMESTAMP\(\)/);
    }
    expect(read('api/user-memberships.ts').match(/closed_at = COALESCE\(closed_at, UTC_TIMESTAMP\(\)\)/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('the migration adds a nullable purchased_at and no backfill', () => {
    const m = read('infra/migrations/286_user_membership_purchased_at.js');
    expect(m).toMatch(/ADD COLUMN purchased_at DATETIME NULL/);
    expect(m).not.toMatch(/UPDATE /);
  });
});
