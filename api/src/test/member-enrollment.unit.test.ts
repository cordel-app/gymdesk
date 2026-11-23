// Unit tests for latestEnrollmentStatusSql() (#809).
//
// The helper is a pure SQL-fragment builder with no DB or HTTP dependency, so
// there are no test gyms, no `request` and no `db.end()` here. What matters is
// that the fragment it returns keeps the three properties its callers
// (`GET /members`' `enrollment_status` column, the dashboards' active-member
// counts) depend on: it is scoped to the caller's `members` row by the alias it
// was given, it is scoped to that row's gym, and it reads the member's *latest*
// assignment. Since #2125 M6b-13 the assignment is read from `plan_snapshots`
// (each assignment's current snapshot, dated by its anchor snapshot).

import { describe, expect, it } from 'vitest';
import { latestEnrollmentStatusSql } from '../domain/memberEnrollment';

/** Collapses runs of whitespace so assertions do not depend on the fragment's indentation. */
const flat = (alias: string) => latestEnrollmentStatusSql(alias).replace(/\s+/g, ' ').trim();

describe('latestEnrollmentStatusSql', () => {
  it('is a parenthesised scalar subquery over plan_snapshots', () => {
    const sql = flat('m');
    expect(sql.startsWith('(')).toBe(true);
    expect(sql.endsWith(')')).toBe(true);
    expect(sql).toContain('SELECT pa.status');
    expect(sql).toContain('FROM plan_snapshots pa');
    expect(sql).not.toMatch(/\bFROM user_memberships\b|\bJOIN user_memberships\b/);
  });

  it('reads the current snapshot of each assignment', () => {
    expect(flat('m')).toContain('pa.id = (SELECT cas.id FROM product_set_plan_snapshots');
  });

  it('filters on the gym and on the plans the member owns or is covered by (#3281)', () => {
    const sql = flat('m');
    expect(sql).toContain('WHERE pa.gym_id = m.gym_id AND (pa.member_id = m.id OR EXISTS (SELECT 1 FROM plan_snapshot_beneficiaries pab');
    expect(sql).toContain('pab.plan_snapshot_id = pa.id AND pab.gym_id = pa.gym_id AND pab.member_id = m.id');
  });

  it('uses whatever alias the caller passes, not a hardcoded one', () => {
    const sql = flat('mem');
    expect(sql).toContain('pa.member_id = mem.id');
    expect(sql).toContain('pa.gym_id = mem.gym_id');
    expect(sql).not.toMatch(/\bm\.id\b/);
    expect(sql).not.toMatch(/\bm\.gym_id\b/);
  });

  it('excludes a Draft and a plan awaiting payment', () => {
    expect(flat('m')).toContain("pa.status NOT IN ('in_cart', 'pending_payment')");
  });

  it('orders by the assignment\'s creation, then its id, and takes a single row', () => {
    const sql = flat('m');
    expect(sql).toContain('anc.created_at DESC, pa.anchor_plan_snapshot_id DESC LIMIT 1');
    // #3113: status priority comes first (Active, then Cancel on End Date, then Cancelled)
    expect(sql.indexOf("'active_cancel_at_period_end', 'to_be_reactivated') THEN 2")).toBeGreaterThan(sql.indexOf("'active', 'to_be_canceled') THEN 0"));
    expect(sql.indexOf('ORDER BY CASE')).toBeGreaterThan(-1);
    expect(sql.indexOf('ORDER BY CASE')).toBeLessThan(sql.indexOf('anc.created_at DESC'));
  });

  it('is deterministic — the same alias always yields the same fragment', () => {
    expect(latestEnrollmentStatusSql('m')).toBe(latestEnrollmentStatusSql('m'));
  });

  it('contains no bound parameter placeholders', () => {
    expect(flat('m')).not.toContain('?');
  });
});
