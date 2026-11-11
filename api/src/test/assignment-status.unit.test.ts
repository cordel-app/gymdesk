// #2659 stage 1 — the persisted Cancels-on-End-Date status is a cancellation
// to every pure rule that asks "was this plan cancelled".
import { describe, expect, it } from 'vitest';
import {
  ASSIGNMENT_STATUSES, CANCELLED_ASSIGNMENT_STATUSES, CANCELS_AT_PERIOD_END_STATUS, isCancelledAssignmentStatus,
} from '../domain/assignmentStatus';
import { countsAsRecentMembership, wasCancelledWithinGrace } from '../domain/newMemberEligibility';

describe('assignment statuses (#2659)', () => {
  it('declares the new value as a stored status and a cancellation', () => {
    expect(ASSIGNMENT_STATUSES).toContain(CANCELS_AT_PERIOD_END_STATUS);
    expect([...CANCELLED_ASSIGNMENT_STATUSES].sort()).toEqual([CANCELS_AT_PERIOD_END_STATUS, 'cancelled'].sort());
    expect(isCancelledAssignmentStatus(CANCELS_AT_PERIOD_END_STATUS)).toBe(true);
    expect(isCancelledAssignmentStatus('cancelled')).toBe(true);
    expect(isCancelledAssignmentStatus('superseded')).toBe(false);
    expect(isCancelledAssignmentStatus('active')).toBe(false);
  });

  it('new-member rules read it as they read cancelled', () => {
    for (const status of ['cancelled', CANCELS_AT_PERIOD_END_STATUS]) {
      const row = { id: 1, status, starts_at: '2025-01-01', ends_at: '2025-03-01', closed_at: '2025-01-10 10:00:00', created_at: '2025-01-01 10:00:00' } as any;
      expect(wasCancelledWithinGrace(row)).toBe(true);
      expect(countsAsRecentMembership(row, '2024-06-01')).toBe(false);
    }
  });
});
