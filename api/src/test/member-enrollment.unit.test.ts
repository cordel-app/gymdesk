// Unit tests for latestEnrollmentStatusSql() (#809).
//
// The helper is a pure SQL-fragment builder with no DB or HTTP dependency, so
// there are no test gyms, no `request` and no `db.end()` here. What matters is
// that the fragment it returns keeps the three properties its two callers
// (`GET /members`' `enrollment_status` column and the Nutrition Dashboard's
// active-member count) depend on: it is scoped to the caller's `members` row by
// the alias it was given, it is scoped to that row's gym, and it reads the
// member's *latest* `user_memberships` row. If those two callers ever disagreed,
// a gym owner reading "12 active members" off a Dashboard card and then
// filtering the Members page by `Enrollment status: Active` would get two
// different sets.

import { describe, expect, it } from 'vitest';
import { latestEnrollmentStatusSql } from '../domain/memberEnrollment';

/** Collapses runs of whitespace so assertions do not depend on the fragment's indentation. */
const flat = (alias: string) => latestEnrollmentStatusSql(alias).replace(/\s+/g, ' ').trim();

describe('latestEnrollmentStatusSql', () => {
  it('is a parenthesised scalar subquery over user_memberships', () => {
    const sql = flat('m');
    expect(sql.startsWith('(')).toBe(true);
    expect(sql.endsWith(')')).toBe(true);
    // One column only — anything wider cannot be used as a scalar in a SELECT
    // list or compared with `= 'active'`.
    expect(sql).toContain('SELECT um.status');
    expect(sql).toContain('FROM user_memberships um');
  });

  it('qualifies both predicates with the alias it was given', () => {
    const sql = flat('m');
    expect(sql).toContain('um.member_id = m.id');
    expect(sql).toContain('um.gym_id = m.gym_id');
  });

  it('filters on both member_id and gym_id', () => {
    const sql = flat('m');
    // Every domain table is filtered by gym_id (CLAUDE.md), and here it also
    // stops a member id from reaching another tenant's membership rows.
    expect(sql).toMatch(/WHERE um\.member_id = m\.id AND um\.gym_id = m\.gym_id/);
  });

  it('uses whatever alias the caller passes, not a hardcoded one', () => {
    const sql = flat('mem');
    expect(sql).toContain('um.member_id = mem.id');
    expect(sql).toContain('um.gym_id = mem.gym_id');
    // `m.` must not survive from a hardcoded default — `mem.` contains no `m.`
    // substring, so a leftover would show up here.
    expect(sql).not.toMatch(/\bm\.id\b/);
    expect(sql).not.toMatch(/\bm\.gym_id\b/);
  });

  it('is unaffected by the alias in the um.* references', () => {
    // The inner alias is the helper's own and must not be renamed by the caller's.
    const sql = flat('um_outer');
    expect(sql).toContain('SELECT um.status');
    expect(sql).toContain('FROM user_memberships um');
    expect(sql).toContain('um.member_id = um_outer.id');
  });

  it('orders created_at DESC, id DESC and takes a single row', () => {
    const sql = flat('m');
    // `id DESC` is the tiebreak that makes the result deterministic for two rows
    // written in the same second — without it the "latest row decides" rule is
    // whatever order the storage engine happens to return.
    expect(sql).toContain('ORDER BY um.created_at DESC, um.id DESC');
    expect(sql).toContain('LIMIT 1');
    expect(sql.indexOf('ORDER BY')).toBeLessThan(sql.indexOf('LIMIT 1'));
  });

  it('is deterministic — the same alias always yields the same fragment', () => {
    expect(latestEnrollmentStatusSql('m')).toBe(latestEnrollmentStatusSql('m'));
  });

  it('contains no bound parameter placeholders', () => {
    // The fragment is interpolated into its caller's SQL string, so it must not
    // consume a positional parameter and shift the caller's own bindings.
    expect(flat('m')).not.toContain('?');
  });
});
