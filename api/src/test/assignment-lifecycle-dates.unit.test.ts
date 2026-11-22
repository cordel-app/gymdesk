import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// #1695 — the lifecycle dates of an assigned Membership Plan. Source-level gate
// (no MySQL): every writer that makes an assignment active stamps `purchased_at`
// once, and every writer that cancels one stamps `closed_at` without overwriting.
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

describe('assignment lifecycle dates (#1695)', () => {
  it('commit and projection stamp purchased_at once', () => {
    // #2125 M6b-51d-7b: the purchase time is the plan snapshot's alone (`writeAssignmentPurchasedAt()`);
    // the lifecycle writer no longer touches it.
    expect(read('api/assignment-lifecycle-writer.ts')).not.toMatch(/purchasedAt\?: 'fill'/);
    expect(read('api/assignment-commit.ts')).toMatch(/status: 'active', from: row\.status, actor: input\.actor/);
    const proj = read('api/product-set-projection.ts');
    expect(proj).toMatch(/status: 'active', actor,\s+notFrom: \['active_cancel_at_period_end', 'cancelled', 'expired', 'superseded'\]/);
    // #2125 M6b-51c-1: a new assignment keeps its predecessor's purchase time, read off the
    // predecessor's plan snapshot, else now; the same value goes on its own snapshot.
    expect(proj).toMatch(/SELECT COALESCE\(\(SELECT pa\.purchased_at FROM plan_snapshots pa/);
    expect(proj).toMatch(/writeAssignmentPurchasedAt\(tx, gymId, umId, purchasedAt\)/);
    expect(read('api/assignment-commit.ts')).toMatch(/writeAssignmentPurchasedAt\(tx, input\.gymId, Number\(row\.id\), 'fill'\)/);
    expect(read('api/plan-assignment-sync.ts')).not.toMatch(/s\.purchased_at = um\.purchased_at/);
  });

  it('every cancelling UPDATE keeps the first closed_at', () => {
    for (const f of ['api/user-memberships.ts', 'api/product-set-projection.ts', 'api/one-active-plan.ts']) {
      const src = read(f);
      expect(src).not.toMatch(/status = 'cancelled', closed_at = UTC_TIMESTAMP\(\)/);
    }
    // #2125 M6b-51c-3: `keep_or_now` is the writer's COALESCE; a cancel route asks for it.
    expect(read('api/assignment-lifecycle-writer.ts')).toMatch(/\$\{closed\} = COALESCE\(\$\{closed\}, \?\)/);
    expect(read('api/user-memberships.ts').match(/status: 'cancelled', closedAt: 'keep_or_now'/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('the migration adds a nullable purchased_at and no backfill', () => {
    const m = read('infra/migrations/286_user_membership_purchased_at.js');
    expect(m).toMatch(/ADD COLUMN purchased_at DATETIME NULL/);
    expect(m).not.toMatch(/UPDATE /);
  });
});
