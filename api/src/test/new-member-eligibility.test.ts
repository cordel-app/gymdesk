// Unit tests for domain/newMemberEligibility — pure functions, no DB.
//
// #634 §3: "Only applicable for new members" means the Member booked their
// first Membership Plan in 12 months — "if a user was member of the gym 12
// months ago and now is coming back, the flag only applicable to new users
// will apply" (issue thread).

import { describe, expect, it } from 'vitest';
import {
  NEW_MEMBER_WINDOW_MONTHS,
  NewMemberAssignment,
  countsAsRecentMembership,
  newMemberCutoff,
  qualifiesAsNewMember,
} from '../domain/newMemberEligibility';

const NOW = new Date('2026-09-23T10:00:00Z');
const CUTOFF = newMemberCutoff(NOW); // 2025-09-23

function assignment(over: Partial<NewMemberAssignment> & { id: number }): NewMemberAssignment {
  return {
    status: 'expired',
    starts_at: '2020-01-01',
    ends_at: null,
    closed_at: null,
    created_at: '2020-01-01 09:00:00',
    ...over,
  };
}

describe('newMemberCutoff', () => {
  it('is the same day 12 months earlier', () => {
    expect(NEW_MEMBER_WINDOW_MONTHS).toBe(12);
    expect(CUTOFF).toBe('2025-09-23');
  });

  it('clamps a day the target month does not have', () => {
    // 31 March minus 1 month would otherwise roll forward into 2 March.
    expect(newMemberCutoff(new Date('2026-03-31T00:00:00Z'), 1)).toBe('2026-02-28');
  });

  it('does not roll 29 February forward into March', () => {
    expect(newMemberCutoff(new Date('2028-02-29T00:00:00Z'), 12)).toBe('2027-02-28');
  });
});

describe('countsAsRecentMembership', () => {
  it('counts a plan the Member still holds, however old', () => {
    expect(countsAsRecentMembership(assignment({ id: 1, status: 'active' }), CUTOFF)).toBe(true);
  });

  it.each(['draft', 'awaiting_payment', 'active', 'paused'])('counts a %s plan', (status) => {
    expect(countsAsRecentMembership(assignment({ id: 1, status }), CUTOFF)).toBe(true);
  });

  it('counts a plan that started inside the window', () => {
    expect(countsAsRecentMembership(
      assignment({ id: 1, starts_at: '2026-02-01', created_at: '2026-02-01 09:00:00' }), CUTOFF,
    )).toBe(true);
  });

  it('counts a plan that ended inside the window', () => {
    expect(countsAsRecentMembership(assignment({ id: 1, ends_at: '2026-01-31' }), CUTOFF)).toBe(true);
  });

  it('counts a plan that was closed inside the window', () => {
    expect(countsAsRecentMembership(
      assignment({ id: 1, closed_at: '2026-01-31 12:00:00' }), CUTOFF,
    )).toBe(true);
  });

  it('ignores a plan that ended before the window', () => {
    expect(countsAsRecentMembership(assignment({ id: 1, ends_at: '2024-12-31' }), CUTOFF)).toBe(false);
  });

  it('reads dates that arrive as Date objects, as mysql2 may return them', () => {
    expect(countsAsRecentMembership(
      assignment({ id: 1, ends_at: new Date('2026-01-31T00:00:00Z') }), CUTOFF,
    )).toBe(true);
  });

  // A superseded row (assign-new-plan) carries neither ends_at nor closed_at:
  // it stopped covering the Member when its successor was created.
  it('dates a superseded plan by the assignment that replaced it', () => {
    const superseded = assignment({ id: 1, starts_at: '2019-01-01', created_at: '2019-01-01 09:00:00' });
    const successor = assignment({ id: 2, status: 'active', created_at: '2026-09-23 09:00:00' });
    expect(countsAsRecentMembership(superseded, CUTOFF, [superseded, successor])).toBe(true);
  });

  it('leaves a superseded plan out when its successor is old too', () => {
    const superseded = assignment({ id: 1, starts_at: '2019-01-01', created_at: '2019-01-01 09:00:00' });
    const successor = assignment({ id: 2, created_at: '2020-01-01 09:00:00', ends_at: '2021-01-01' });
    expect(countsAsRecentMembership(superseded, CUTOFF, [superseded, successor])).toBe(false);
  });
});

describe('qualifiesAsNewMember', () => {
  it('treats a Member with no assignments as new', () => {
    expect(qualifiesAsNewMember([], CUTOFF)).toBe(true);
  });

  it('never counts the assignment the promotion is being applied to', () => {
    const first = assignment({ id: 7, status: 'active', starts_at: '2026-09-23', created_at: '2026-09-23 09:00:00' });
    expect(qualifiesAsNewMember([first], CUTOFF, 7)).toBe(true);
    expect(qualifiesAsNewMember([first], CUTOFF, null)).toBe(false);
  });

  it('refuses a Member who already holds another plan (§6 parallel plans)', () => {
    const held = assignment({ id: 1, status: 'active', starts_at: '2019-01-01' });
    const second = assignment({ id: 2, status: 'active', starts_at: '2026-09-23', created_at: '2026-09-23 09:00:00' });
    expect(qualifiesAsNewMember([held, second], CUTOFF, 2)).toBe(false);
  });

  it('accepts a Member coming back more than 12 months later', () => {
    const lapsed = assignment({ id: 1, starts_at: '2022-01-01', ends_at: '2024-06-30' });
    const returning = assignment({ id: 2, status: 'active', starts_at: '2026-09-23', created_at: '2026-09-23 09:00:00' });
    expect(qualifiesAsNewMember([lapsed, returning], CUTOFF, 2)).toBe(true);
  });

  it('refuses a Member whose previous plan ended inside the window', () => {
    const lapsed = assignment({ id: 1, starts_at: '2022-01-01', ends_at: '2026-03-31' });
    const returning = assignment({ id: 2, status: 'active', starts_at: '2026-09-23', created_at: '2026-09-23 09:00:00' });
    expect(qualifiesAsNewMember([lapsed, returning], CUTOFF, 2)).toBe(false);
  });

  it('refuses a Member renewed through Assign New Plan for years', () => {
    // Every superseded row is 'expired' with no end dates; only the chain of
    // creation timestamps says the Member never actually left.
    const oldest = assignment({ id: 1, starts_at: '2019-01-01', created_at: '2019-01-01 09:00:00' });
    const middle = assignment({ id: 2, starts_at: '2022-01-01', created_at: '2022-01-01 09:00:00' });
    const newest = assignment({ id: 3, status: 'active', starts_at: '2026-09-23', created_at: '2026-09-23 09:00:00' });
    expect(qualifiesAsNewMember([oldest, middle, newest], CUTOFF, 3)).toBe(false);
  });
});
