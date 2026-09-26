import { describe, expect, it } from 'vitest';
import {
  RunGuardRow,
  STALE_RUN_MINUTES,
  evaluateRunGuard,
  isStaleRun,
  toDateOnly,
  utcDateString,
} from '../domain/runGuard';

/**
 * #780: the nightly run guard. Pure, so every case the ticket names — a late
 * cron, a crashed run, a stale lock — is clock arithmetic rather than a
 * database fixture.
 */

const NOW = new Date('2026-09-26T06:00:00.000Z');

function minutesAgo(n: number): Date {
  return new Date(NOW.getTime() - n * 60_000);
}
function hoursAgo(n: number): Date {
  return minutesAgo(n * 60);
}

function row(overrides: Partial<RunGuardRow> = {}): RunGuardRow {
  return {
    run_date: '2026-09-26',
    status: 'completed',
    started_at: minutesAgo(5),
    ...overrides,
  };
}

describe('utcDateString / toDateOnly', () => {
  it('reads the UTC calendar date of a moment', () => {
    expect(utcDateString(new Date('2026-09-26T23:59:59.000Z'))).toBe('2026-09-26');
    // 00:30 CEST on the 27th is still the 26th in UTC, which is the date the
    // guard counts — the run is scheduled in UTC and so is its log.
    expect(utcDateString(new Date('2026-09-26T22:30:00.000Z'))).toBe('2026-09-26');
  });

  it('accepts a DATE column as either a string or a Date (mysql2 returns both)', () => {
    expect(toDateOnly('2026-09-26')).toBe('2026-09-26');
    expect(toDateOnly(new Date('2026-09-26T00:00:00.000Z'))).toBe('2026-09-26');
  });
});

describe('isStaleRun', () => {
  it('holds the lock while the run is younger than the stale window', () => {
    expect(isStaleRun(minutesAgo(STALE_RUN_MINUTES - 1), NOW)).toBe(false);
  });

  it('releases it once the window has passed', () => {
    expect(isStaleRun(minutesAgo(STALE_RUN_MINUTES + 1), NOW)).toBe(true);
  });

  it('treats a row with no start time as stale rather than as an eternal lock', () => {
    expect(isStaleRun(null, NOW)).toBe(true);
  });

  it('reads a MySQL DATETIME string as UTC', () => {
    // `2026-09-26 05:59:00` is one minute ago, not hours off by the container's
    // local zone — the schema stores UTC by convention.
    expect(isStaleRun('2026-09-26 05:59:00', NOW)).toBe(false);
  });
});

describe('evaluateRunGuard', () => {
  it('allows the first run of the day against an empty history', () => {
    expect(evaluateRunGuard([], NOW)).toEqual({ allow: true });
  });

  // The defect the ticket opens with: Monday ran late at 07:30, Tuesday fires
  // on time at 06:00, and the old 23-hour window refused it — so nobody was
  // charged on Tuesday.
  it('allows today after a completed run 22.5 hours ago on yesterday’s date', () => {
    const late = evaluateRunGuard(
      [row({ run_date: '2026-09-25', started_at: hoursAgo(22.5) })],
      NOW,
    );
    expect(late).toEqual({ allow: true });
  });

  it('refuses a second run once today’s has completed', () => {
    expect(evaluateRunGuard([row()], NOW)).toEqual({
      allow: false,
      reason: 'already_completed_today',
      runDate: '2026-09-26',
    });
  });

  // The second defect: the old stamp was written before the first membership
  // was touched, so a run that threw locked the day.
  it('allows a re-run after today’s run failed', () => {
    expect(evaluateRunGuard([row({ status: 'failed' })], NOW)).toEqual({ allow: true });
  });

  it('refuses while a run started moments ago is still in progress', () => {
    const decision = evaluateRunGuard(
      [row({ status: 'in_progress', started_at: minutesAgo(2) })],
      NOW,
    );
    expect(decision).toMatchObject({ allow: false, reason: 'in_progress' });
  });

  it('allows a takeover once an in-progress run has gone stale', () => {
    const decision = evaluateRunGuard(
      [row({ status: 'in_progress', started_at: minutesAgo(STALE_RUN_MINUTES + 5) })],
      NOW,
    );
    expect(decision).toEqual({ allow: true });
  });

  it('reports the completed run rather than the lock when both exist', () => {
    const decision = evaluateRunGuard(
      [
        row({ status: 'in_progress', started_at: minutesAgo(1) }),
        row({ status: 'completed' }),
      ],
      NOW,
    );
    expect(decision).toMatchObject({ reason: 'already_completed_today' });
  });

  it('ignores an in-progress row from a previous day that never closed', () => {
    const decision = evaluateRunGuard(
      [row({ run_date: '2026-09-25', status: 'in_progress', started_at: hoursAgo(24) })],
      NOW,
    );
    expect(decision).toEqual({ allow: true });
  });

  it('is not fooled by a completed run on another date', () => {
    const decision = evaluateRunGuard(
      [row({ run_date: '2026-09-27', started_at: minutesAgo(1) })],
      NOW,
    );
    expect(decision).toEqual({ allow: true });
  });
});
