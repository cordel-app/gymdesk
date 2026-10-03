// Unit tests for domain/oneActivePlan.ts — the pure half of #956's
// "one member, one Membership Plan" rule. No DB, no HTTP: the SQL half
// (findLiveAssignmentsForMembers / supersedeLiveAssignments) is exercised
// through the routes in one-active-membership-plan.test.ts.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ACTIVE_PLAN_EXISTS,
  LIVE_ASSIGNMENT_STATUSES,
  LiveAssignment,
  activePlanConflictBody,
  isLiveAssignmentStatus,
  supersedeStartsAtError,
} from '../domain/oneActivePlan';

function assignment(over: Partial<LiveAssignment> = {}): LiveAssignment {
  return {
    id: 7,
    owner_member_id: 1,
    owner_member_name: 'Ada',
    blocked_member_id: 1,
    blocked_member_name: 'Ada',
    membership_plan_id: 3,
    membership_plan_name: 'Premium Membership',
    status: 'active',
    starts_at: '2026-01-01',
    ends_at: null,
    ...over,
  };
}

describe('LIVE_ASSIGNMENT_STATUSES (#956 Q2)', () => {
  it('counts active and paused, and nothing else', () => {
    // A paused assignment is live, not cancelled — if it did not count, pausing
    // would be a way around the rule. cancelled/expired are history.
    expect([...LIVE_ASSIGNMENT_STATUSES]).toEqual(['active', 'paused']);
  });

  it('isLiveAssignmentStatus accepts only those two', () => {
    expect(isLiveAssignmentStatus('active')).toBe(true);
    expect(isLiveAssignmentStatus('paused')).toBe(true);
    expect(isLiveAssignmentStatus('cancelled')).toBe(false);
    expect(isLiveAssignmentStatus('expired')).toBe(false);
    // 'pending' is a derived lifecycle_status and is never stored.
    expect(isLiveAssignmentStatus('pending')).toBe(false);
    expect(isLiveAssignmentStatus(undefined)).toBe(false);
  });
});

describe('activePlanConflictBody', () => {
  it('carries the code, both plan names and the current plan with its dates', () => {
    const body = activePlanConflictBody([assignment()], 'Basic Membership');
    expect(body.error).toBe(ACTIVE_PLAN_EXISTS);
    expect(body.message).toContain('Premium Membership');
    expect(body.message).toContain('Basic Membership');
    // The dialog renders from this without a second read of the assignment.
    expect(body.current_plan.id).toBe(7);
    expect(body.current_plan.starts_at).toBe('2026-01-01');
    expect(body.conflicts).toHaveLength(1);
  });

  it('names the first conflict as the current plan', () => {
    const body = activePlanConflictBody(
      [assignment({ id: 9, membership_plan_name: 'Gold' }), assignment({ id: 4 })],
      'Basic',
    );
    expect(body.current_plan.id).toBe(9);
    expect(body.conflicts.map((c) => c.id)).toEqual([9, 4]);
  });

  it('counts the members when a multi-member assignment blocks several', () => {
    const body = activePlanConflictBody(
      [assignment({ id: 1, blocked_member_id: 1 }), assignment({ id: 2, blocked_member_id: 2 })],
      'Family',
    );
    expect(body.message).toMatch(/2 of the selected members/);
  });

  it('words around a plan with no name rather than printing null', () => {
    const body = activePlanConflictBody([assignment({ membership_plan_name: null })], null);
    expect(body.message).not.toContain('null');
    expect(body.message).toContain('their current Membership Plan');
    expect(body.message).toContain('the new Membership Plan');
  });
});

describe('supersedeStartsAtError', () => {
  it('refuses a replacement that starts before the plan it replaces', () => {
    // The superseded row's ends_at is stamped with this date, and an ends_at
    // before its own starts_at is a history no screen can render.
    const error = supersedeStartsAtError('2025-12-31', [assignment({ starts_at: '2026-01-01' })]);
    expect(error).toContain('2026-01-01');
  });

  it('allows the same day — a same-day correction is a zero-day plan', () => {
    expect(supersedeStartsAtError('2026-01-01', [assignment({ starts_at: '2026-01-01' })])).toBeNull();
  });

  it('allows a later date, including a future one', () => {
    expect(supersedeStartsAtError('2027-06-01', [assignment({ starts_at: '2026-01-01' })])).toBeNull();
  });

  it('checks every conflict, not only the first', () => {
    const error = supersedeStartsAtError('2026-02-01', [
      assignment({ id: 1, starts_at: '2026-01-01' }),
      assignment({ id: 2, starts_at: '2026-03-01' }),
    ]);
    expect(error).toContain('2026-03-01');
  });

  it('is null with nothing to supersede', () => {
    expect(supersedeStartsAtError('2026-01-01', [])).toBeNull();
  });
});

describe('migration 213 and the rule agree on what "live" means', () => {
  // The migration is frozen SQL and cannot import this module, so it spells
  // `('active', 'paused')` literally and the report script derives its clause
  // from `LIVE_ASSIGNMENT_STATUSES`. The migration's sweep and the report's
  // `keeper` have to describe the same set — the report is what an operator
  // reads before letting the sweep cancel anything — so a change to the
  // constant has to fail here rather than silently diverge from the one file
  // that cannot follow it.
  const source = readFileSync(
    new URL('../infra/migrations/213_one_active_membership_plan.js', import.meta.url),
    'utf8',
  );

  it('the migration hardcodes exactly the live statuses this module declares', () => {
    const literal = `(${LIVE_ASSIGNMENT_STATUSES.map((s) => `'${s}'`).join(', ')})`;
    expect(literal).toBe("('active', 'paused')");
    // Both places the migration narrows to live rows: the orphan pre-check and
    // the sweep's own read.
    const occurrences = source.split(`status IN ${literal}`).length - 1;
    expect(occurrences).toBe(2);
  });

  it('the migration names no other status in a WHERE clause', () => {
    const inClauses = source.match(/status IN \([^)]*\)/g) ?? [];
    expect(inClauses.length).toBeGreaterThan(0);
    for (const clause of inClauses) {
      expect(clause).toBe("status IN ('active', 'paused')");
    }
  });
});
