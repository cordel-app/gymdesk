// Unit tests for domain/newMemberEligibility — pure functions, no DB.
//
// #634 §3: "Only applicable for new members" means the Member booked their
// first Membership Plan inside the window — "if a user was member of the gym
// 12 months ago and now is coming back, the flag only applicable to new users
// will apply" (issue thread).
//
// #927 shortened that window to six months — "A member is considered a New
// Member when they have not had an active Membership Plan during the previous
// 6 months" — for the Member's own `New Member` status *and* for Promotions,
// per the answer on its thread ("6 months here and in promotions"). There is
// one window, so these tests are also what stops a second one appearing.

import { describe, expect, it } from 'vitest';
import {
  NEW_MEMBER_WINDOW_MONTHS,
  NewMemberAssignment,
  countsAsRecentMembership,
  newMemberCutoff,
  qualifiesAsNewMember,
} from '../domain/newMemberEligibility';

const NOW = new Date('2026-09-23T10:00:00Z');
const CUTOFF = newMemberCutoff(NOW); // 2026-03-23

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
  it('is the same day six months earlier (#927)', () => {
    expect(NEW_MEMBER_WINDOW_MONTHS).toBe(6);
    expect(CUTOFF).toBe('2026-03-23');
  });

  it('is the one window the Member status and Promotions share (#927 §5)', () => {
    // The badge the Members list shows and the window the four Promotion apply
    // paths enforce are this constant — "6 months here and in promotions". A
    // member who left seven months ago is new to both, which is the behaviour
    // change the ticket asked for.
    const sevenMonthsAgo = assignment({ id: 1, starts_at: '2025-06-01', ends_at: '2026-02-20' });
    expect(countsAsRecentMembership(sevenMonthsAgo, CUTOFF)).toBe(false);
    const fiveMonthsAgo = assignment({ id: 2, starts_at: '2025-06-01', ends_at: '2026-04-20' });
    expect(countsAsRecentMembership(fiveMonthsAgo, CUTOFF)).toBe(true);
  });

  it('counts the cutoff day itself as inside the window', () => {
    expect(countsAsRecentMembership(assignment({ id: 1, ends_at: CUTOFF }), CUTOFF)).toBe(true);
    expect(countsAsRecentMembership(assignment({ id: 1, ends_at: '2026-03-22' }), CUTOFF)).toBe(false);
  });

  it('clamps a day the target month does not have', () => {
    // 31 March minus 1 month would otherwise roll forward into 2 March.
    expect(newMemberCutoff(new Date('2026-03-31T00:00:00Z'), 1)).toBe('2026-02-28');
  });

  it('does not roll 29 February forward into March', () => {
    expect(newMemberCutoff(new Date('2028-02-29T00:00:00Z'), 12)).toBe('2027-02-28');
    expect(newMemberCutoff(new Date('2026-08-31T00:00:00Z'))).toBe('2026-02-28');
  });
});

describe('countsAsRecentMembership', () => {
  it('counts a plan the Member still holds, however old', () => {
    expect(countsAsRecentMembership(assignment({ id: 1, status: 'active' }), CUTOFF)).toBe(true);
  });

  it.each(['active', 'paused'])('counts a %s plan', (status) => {
    expect(countsAsRecentMembership(assignment({ id: 1, status }), CUTOFF)).toBe(true);
  });

  it('counts a plan that started inside the window', () => {
    expect(countsAsRecentMembership(
      assignment({ id: 1, starts_at: '2026-06-01', created_at: '2026-06-01 09:00:00' }), CUTOFF,
    )).toBe(true);
  });

  it('counts a plan that ended inside the window', () => {
    expect(countsAsRecentMembership(assignment({ id: 1, ends_at: '2026-06-30' }), CUTOFF)).toBe(true);
  });

  it('counts a plan that was closed inside the window', () => {
    expect(countsAsRecentMembership(
      assignment({ id: 1, closed_at: '2026-06-30 12:00:00' }), CUTOFF,
    )).toBe(true);
  });

  it('ignores a plan that ended before the window', () => {
    expect(countsAsRecentMembership(assignment({ id: 1, ends_at: '2025-12-31' }), CUTOFF)).toBe(false);
  });

  it('reads dates that arrive as Date objects, as mysql2 may return them', () => {
    expect(countsAsRecentMembership(
      assignment({ id: 1, ends_at: new Date('2026-06-30T00:00:00Z') }), CUTOFF,
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

  it('accepts a Member coming back more than six months later', () => {
    const lapsed = assignment({ id: 1, starts_at: '2022-01-01', ends_at: '2026-01-31' });
    const returning = assignment({ id: 2, status: 'active', starts_at: '2026-09-23', created_at: '2026-09-23 09:00:00' });
    expect(qualifiesAsNewMember([lapsed, returning], CUTOFF, 2)).toBe(true);
  });

  it('refuses a Member whose previous plan ended inside the window', () => {
    const lapsed = assignment({ id: 1, starts_at: '2022-01-01', ends_at: '2026-06-30' });
    const returning = assignment({ id: 2, status: 'active', starts_at: '2026-09-23', created_at: '2026-09-23 09:00:00' });
    expect(qualifiesAsNewMember([lapsed, returning], CUTOFF, 2)).toBe(false);
  });

  it('answers the Member\'s own status with nothing excluded (#927)', () => {
    // The Member-level status has no assignment being configured, so a live
    // plan counts and a Member holding one reads as not new — the ticket's
    // fourth example. A Member with no assignments at all is new (its first).
    const live = assignment({ id: 1, status: 'active', starts_at: '2019-01-01' });
    expect(qualifiesAsNewMember([live], CUTOFF, null)).toBe(false);
    expect(qualifiesAsNewMember([], CUTOFF, null)).toBe(true);
    const longGone = assignment({ id: 2, starts_at: '2019-01-01', ends_at: '2020-01-01' });
    expect(qualifiesAsNewMember([longGone], CUTOFF, null)).toBe(true);
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
