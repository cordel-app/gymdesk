// Unit tests for domain/trainerAssignment.ts (#986) — no DB, no HTTP.

import { describe, expect, it } from 'vitest';
import {
  ASSIGNABLE_TRAINERS_FROM,
  assignableTrainersSql,
  parseTrainerMembershipId,
  trainerWriteNeedsLookup,
} from '../domain/trainerAssignment';

describe('parseTrainerMembershipId', () => {
  it('reads an absent, empty or null value as a clear', () => {
    expect(parseTrainerMembershipId(undefined)).toEqual({ id: null });
    expect(parseTrainerMembershipId(null)).toEqual({ id: null });
    expect(parseTrainerMembershipId('')).toEqual({ id: null });
  });

  it('accepts a number and a numeric string', () => {
    expect(parseTrainerMembershipId(7)).toEqual({ id: 7 });
    expect(parseTrainerMembershipId('7')).toEqual({ id: 7 });
  });

  it('refuses anything that is not a positive integer', () => {
    expect(parseTrainerMembershipId('abc')).toHaveProperty('error');
    expect(parseTrainerMembershipId(0)).toHaveProperty('error');
    expect(parseTrainerMembershipId(-3)).toHaveProperty('error');
  });
});

describe('trainerWriteNeedsLookup', () => {
  it('never looks up a clear — removing the trainer is always allowed', () => {
    expect(trainerWriteNeedsLookup(null, null)).toBe(false);
    expect(trainerWriteNeedsLookup(null, 7)).toBe(false);
  });

  // #986 §3: the value a row already holds is not a new selection, so an edit
  // of an unrelated field cannot fail because that trainer has since left.
  it('does not look up a value the row already holds', () => {
    expect(trainerWriteNeedsLookup(7, 7)).toBe(false);
  });

  it('looks up every actual selection', () => {
    expect(trainerWriteNeedsLookup(7, null)).toBe(true);
    expect(trainerWriteNeedsLookup(8, 7)).toBe(true);
  });
});

describe('assignableTrainersSql', () => {
  const sql = assignableTrainersSql('gm.id');

  it('is scoped to the gym, to live staff rows and to active employment', () => {
    expect(ASSIGNABLE_TRAINERS_FROM).toContain('s.gym_id = ?');
    expect(ASSIGNABLE_TRAINERS_FROM).toContain('s.deleted_at IS NULL');
    expect(ASSIGNABLE_TRAINERS_FROM).toContain("s.employment_status = 'active'");
  });

  // The whole of #986: eligibility is employment status, so no role, center,
  // professional service or current_status condition may come back here.
  it('filters on nothing else', () => {
    expect(sql).not.toContain('role');
    expect(sql).not.toContain('current_status');
    expect(sql).not.toContain('center');
    expect(sql).not.toContain('professional_service');
  });

  it('orders by first name then last name (§5)', () => {
    expect(sql).toMatch(/ORDER BY\s+s\.first_name ASC, s\.last_name ASC/);
  });

  it('projects the columns it is given', () => {
    expect(assignableTrainersSql('gm.id AS gym_membership_id')).toContain('SELECT gm.id AS gym_membership_id');
  });
});
