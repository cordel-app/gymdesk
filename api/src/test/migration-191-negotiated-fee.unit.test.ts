/**
 * Guards on migration 191's two `final_price` backfills (#635 stage 15, #777).
 *
 * The migration drops the column the predicates read, so once it has run no
 * integration test can exercise them against the schema — which is why the
 * migration exports the two WHERE fragments and this test pins each clause by
 * reading them back. Same shape as `nutrition-library-quality-classification`:
 * a unit test over data the migration module exports.
 */

import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(__filename);
const migration = require('../infra/migrations/191_retire_stored_final_price.js') as {
  BACKFILL_CANDIDATE: string;
  NEGOTIATED_CANDIDATE: string;
  DISAGREEING_FEE: string;
};

const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('migration 191 — the negotiated price the snapshot never carried (#777)', () => {
  const sql = squash(migration.NEGOTIATED_CANDIDATE);

  it('only moves a price that is still there to move', () => {
    expect(sql).toContain('um.final_price IS NOT NULL');
  });

  it('keys on a non-empty discount_reason — the only marker of a negotiated price', () => {
    // `discount_reason IS NOT NULL` alone would let an empty string through, and
    // `POST /user-memberships` trims before it writes, so an empty reason is a
    // row that never had an override.
    expect(sql).toContain("um.discount_reason IS NOT NULL AND TRIM(um.discount_reason) <> ''");
  });

  it('is disjoint from the last-resort backfill and a no-op on re-run', () => {
    // The first pass keys on `membership_fee_price IS NULL`; this one on it
    // holding a *different* number. `<>` is exact on two DECIMAL(10,2) columns,
    // so a row the first pass just wrote (fee = final_price) and a row that
    // already agreed are both skipped.
    expect(sql).toContain('um.membership_fee_price IS NOT NULL');
    expect(sql).toContain('um.membership_fee_price <> um.final_price');
    expect(squash(migration.BACKFILL_CANDIDATE)).toContain('um.membership_fee_price IS NULL');
  });

  it("leaves a terminal assignment's configuration as history", () => {
    expect(sql).toContain("um.status NOT IN ('cancelled', 'expired')");
  });

  it('skips an assignment with any Promotion application, whatever its status today', () => {
    // A standing application has its discount baked into `final_price`. A
    // revoked one is no better: before stage 15 every apply/revoke recomputed
    // the column from scratch (from the catalogue fee, or from `base_price` = 0
    // under the legacy rule), so the negotiated number is gone either way and a
    // `status = 'applied'` filter would freeze a 0.00 as a 100 % override.
    expect(sql).toMatch(
      /NOT EXISTS \( SELECT 1 FROM user_membership_promotions ump WHERE ump\.user_membership_id = um\.id AND ump\.gym_id = um\.gym_id \)/,
    );
    expect(sql).not.toContain("ump.status = 'applied'");
  });

  it('counts what it leaves behind with the same fee-disagreement guards, minus the two it narrows by', () => {
    const left = squash(migration.DISAGREEING_FEE);
    expect(sql.startsWith(left)).toBe(true);
    expect(left).not.toContain('discount_reason');
    expect(left).not.toContain('user_membership_promotions');
  });

  it('does not gate on discount_expires_at — the column means "what was agreed", not "what is in force"', () => {
    // A lapsed agreement resolves the catalogue price anyway through
    // `regularMembershipFee()`'s `ignoreFrozenFee`; excluding it here would
    // reach the same place while making the column mean something else.
    expect(sql).not.toContain('discount_expires_at');
  });

  it('never writes the fee alone onto an uncaptured row', () => {
    // A row this pass touches already carries `membership_fee_price`, which is
    // one of the disjuncts that define `has_billing_snapshot` — so it is
    // captured by definition and needs no materialisation. The hazard belongs
    // to the first pass only, which is the one keyed on the column being NULL.
    expect(sql).not.toContain('free_months');
    expect(sql).not.toContain('recurring_billing');
  });
});
