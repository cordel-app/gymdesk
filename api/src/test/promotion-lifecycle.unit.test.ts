// #900: the Promotion lifecycle rule, asserted without a database.
//
// Two things are worth pinning here. The expiry clause must name `active` and
// nothing else (an `inactive` Promotion was switched off deliberately, §5), and
// the status union has to agree with the CHECK in migration 202 — CLAUDE.md's
// "a new value goes in two places" only holds if something fails when it goes
// in one.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EXPIRABLE_STATUSES,
  PROMOTION_LIFECYCLE_STATUSES,
  PromotionLifecycleStatus,
  promotionExpiryWhereSql,
} from '../domain/promotionLifecycle';

const MIGRATION = join(__dirname, '../infra/migrations/202_promotion_expired_status.js');

describe('promotionExpiryWhereSql', () => {
  const sql = promotionExpiryWhereSql('p');

  it('only expires a Promotion that is currently active', () => {
    expect(sql).toContain("p.lifecycle_status IN ('active')");
    expect(sql).not.toContain("'inactive'");
    expect(sql).not.toContain("'deleted'");
    // Excluding 'expired' is what makes the sweep idempotent (§2): its second
    // run matches no row it already moved.
    expect(sql).not.toContain("'expired'");
  });

  it('never expires a Promotion without an end date (§6)', () => {
    expect(sql).toContain('p.ends_at IS NOT NULL');
  });

  it('compares the end date against the database clock, not the API process', () => {
    expect(sql).toContain('p.ends_at < UTC_TIMESTAMP()');
    expect(sql).not.toMatch(/\?/); // no parameters: nothing is bound from Node
  });

  it('applies the alias the caller passes to every column it names', () => {
    const aliased = promotionExpiryWhereSql('promo');
    expect(aliased).toContain('promo.lifecycle_status');
    expect(aliased).toContain('promo.ends_at IS NOT NULL');
    expect(aliased).toContain('promo.ends_at < UTC_TIMESTAMP()');
  });
});

describe('the lifecycle status lists', () => {
  it('accepts active, inactive and expired on the API surface', () => {
    expect([...PROMOTION_LIFECYCLE_STATUSES]).toEqual(['active', 'inactive', 'expired']);
  });

  it('never accepts deleted — that is the Recycle Bin, not a status a client sets', () => {
    expect(PROMOTION_LIFECYCLE_STATUSES).not.toContain('deleted' as PromotionLifecycleStatus);
  });

  it('only active can expire naturally', () => {
    expect([...EXPIRABLE_STATUSES]).toEqual(['active']);
  });
});

describe('migration 202 is the other half of the union', () => {
  const source = readFileSync(MIGRATION, 'utf8');

  it('widens chk_promotions_lifecycle_status to every status the code may write', () => {
    for (const status of [...PROMOTION_LIFECYCLE_STATUSES, 'deleted']) {
      expect(source, `migration 202 must permit '${status}'`).toContain(`'${status}'`);
    }
  });

  it('rolls back by mapping expired to active before narrowing the CHECK', () => {
    // Narrowing with an `expired` row still in the table is rejected by MySQL,
    // and DDL is not transactional — the DROP would already have run.
    const down = source.slice(source.indexOf('exports.down'));
    expect(down).toContain("lifecycle_status: 'expired'");
    // `active`, not `inactive`: the sweep only ever expires an `active` row, so
    // a rollback that parked these on `inactive` would strand them there for
    // ever — in the status that means somebody switched the Promotion off.
    expect(down).toContain("update({ lifecycle_status: 'active' })");
    expect(down).not.toContain("update({ lifecycle_status: 'inactive' })");
    expect(down.indexOf('update(')).toBeLessThan(down.indexOf('setLifecycleCheck'));
  });
});
