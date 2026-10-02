// #977 — a calendar event's execution status. Pure functions, no DB and no
// HTTP, so this is a unit test (CLAUDE.md): `domain/eventExecutionStatus.ts`
// decides what `Not used` means and every admin-facing read only reports it.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  EVENT_EXECUTION_STATUSES,
  eventExecutionStatus,
  withEventExecutionStatus,
} from '../domain/eventExecutionStatus';
import { PERMISSION_MATRIX } from '../infra/permissions';

const NOW = new Date('2026-10-02T12:00:00Z');
const PAST = '2026-10-02T11:00:00Z';
const FUTURE = '2026-10-02T13:00:00Z';

describe('eventExecutionStatus', () => {
  it('keeps a future event scheduled, booked or not', () => {
    // §2 — a future empty slot is perfectly valid and asks nothing of anybody.
    expect(eventExecutionStatus({ status: 'scheduled', ends_at: FUTURE, booked_count: 0 }, NOW)).toBe('scheduled');
    expect(eventExecutionStatus({ status: 'scheduled', ends_at: FUTURE, booked_count: 3 }, NOW)).toBe('scheduled');
  });

  it('reports a passed, unbooked slot as not_used', () => {
    // §3 — the whole point of the derivation: a gym whose calendar is mostly
    // open slots for private classes gets no confirmation task per empty hour.
    expect(eventExecutionStatus({ status: 'scheduled', ends_at: PAST, booked_count: 0 }, NOW)).toBe('not_used');
  });

  it('leaves a passed, booked event scheduled until somebody confirms it', () => {
    // §4/§13 — a booked past session is never completed automatically.
    expect(eventExecutionStatus({ status: 'scheduled', ends_at: PAST, booked_count: 1 }, NOW)).toBe('scheduled');
  });

  it('classifies an event that ends exactly now as ended', () => {
    expect(eventExecutionStatus({ status: 'scheduled', ends_at: NOW.toISOString(), booked_count: 0 }, NOW)).toBe('not_used');
  });

  it('lets an explicit decision outrank the clock in both directions', () => {
    // §5 — `Completed · 0 attendees` is reachable: a teacher may have held the
    // session with nobody there, and that must not be re-read as `not_used`.
    expect(eventExecutionStatus({ status: 'completed', ends_at: PAST, booked_count: 0 }, NOW)).toBe('completed');
    // …and a cancelled slot is cancelled however empty it was (§6).
    expect(eventExecutionStatus({ status: 'cancelled', ends_at: PAST, booked_count: 0 }, NOW)).toBe('cancelled');
    // A decision taken before the event even runs still stands.
    expect(eventExecutionStatus({ status: 'cancelled', ends_at: FUTURE, booked_count: 2 }, NOW)).toBe('cancelled');
    expect(eventExecutionStatus({ status: 'completed', ends_at: FUTURE, booked_count: 2 }, NOW)).toBe('completed');
  });

  it('answers null for a status outside the execution axis', () => {
    // A `draft` manual event was never put on the calendar, so it neither ran
    // nor went unused — and no fifth execution value is invented for it.
    expect(eventExecutionStatus({ status: 'draft', ends_at: PAST, booked_count: 0 }, NOW)).toBeNull();
    expect(eventExecutionStatus({ status: null, ends_at: PAST, booked_count: 0 }, NOW)).toBeNull();
    expect(eventExecutionStatus({ status: 'something_else', ends_at: PAST, booked_count: 0 }, NOW)).toBeNull();
  });

  it('never reports not_used from a missing or unusable input', () => {
    // A read that did not project the booking count, or a row with no end
    // time, is not evidence that nobody came: saying `scheduled` leaves the
    // event alone, saying `not_used` would file it away as never having run.
    expect(eventExecutionStatus({ status: 'scheduled', ends_at: PAST, booked_count: null }, NOW)).toBe('scheduled');
    expect(eventExecutionStatus({ status: 'scheduled', ends_at: PAST, booked_count: undefined }, NOW)).toBe('scheduled');
    expect(eventExecutionStatus({ status: 'scheduled', ends_at: null, booked_count: 0 }, NOW)).toBe('scheduled');
    expect(eventExecutionStatus({ status: 'scheduled', ends_at: 'not a date', booked_count: 0 }, NOW)).toBe('scheduled');
  });

  it('reads both shapes mysql2 can hand it', () => {
    // The pool runs at timezone 'Z', so a DATETIME arrives as a Date; a
    // JSON-shaped caller passes the ISO string.
    expect(eventExecutionStatus({ status: 'scheduled', ends_at: new Date(PAST), booked_count: 0 }, NOW)).toBe('not_used');
    // mysql2 returns COUNT(*) as a number, but a DECIMAL-ish string must not
    // read as zero bookings.
    expect(eventExecutionStatus({ status: 'scheduled', ends_at: PAST, booked_count: '2' }, NOW)).toBe('scheduled');
  });

  it('declares exactly the four statuses the ticket names', () => {
    expect([...EVENT_EXECUTION_STATUSES]).toEqual(['scheduled', 'not_used', 'completed', 'cancelled']);
    // `Completed`, not `Held` (§1).
    expect(EVENT_EXECUTION_STATUSES).not.toContain('held' as never);
  });
});

describe('withEventExecutionStatus', () => {
  it('adds the field to every row and changes nothing else', () => {
    const rows = [
      { id: 1, status: 'scheduled', ends_at: PAST, booked_count: 0 },
      { id: 2, status: 'scheduled', ends_at: PAST, booked_count: 1 },
      { id: 3, status: 'completed', ends_at: PAST, booked_count: 0 },
    ];
    const shaped = withEventExecutionStatus(rows, NOW);
    expect(shaped.map((r) => r.execution_status)).toEqual(['not_used', 'scheduled', 'completed']);
    expect(shaped.map((r) => r.id)).toEqual([1, 2, 3]);
    // The input is not mutated — the audit rows the router writes keep the
    // row as the database returned it.
    expect(rows[0]).not.toHaveProperty('execution_status');
  });

  it('is empty-safe', () => {
    expect(withEventExecutionStatus([], NOW)).toEqual([]);
  });
});

describe('the status is derived, not stored (#977)', () => {
  const API_SRC = join(__dirname, '..');
  const router = readFileSync(join(API_SRC, 'api', 'calendar-events.ts'), 'utf-8');

  it('is named by no migration and written by no statement', () => {
    // There is no column to write: `not_used` is a function of the clock, so a
    // stored copy would need a nightly sweep, and a night the sweep missed
    // would report yesterday's empty slots as still Scheduled.
    expect(router).not.toMatch(/execution_status\s*=/);
    const migrations = readdirSync(join(API_SRC, 'infra', 'migrations'));
    const offenders = migrations.filter((file) =>
      readFileSync(join(API_SRC, 'infra', 'migrations', file), 'utf-8').includes('execution_status'));
    expect(offenders, 'a migration names execution_status — the status is derived on read').toEqual([]);
  });

  it('reports it on every read of either router', () => {
    // A read that returned rows straight from the driver would be the one
    // surface that cannot say whether a slot went unused.
    expect(router).toContain("from '../domain/eventExecutionStatus'");
    const rawReads = router.match(/res\.(?:status\(201\)\.)?json\((?:rows\[0\]|rows|row)\)/g) ?? [];
    expect(rawReads, `reads returning raw rows: ${rawReads.join(', ')}`).toHaveLength(0);
  });
});

describe('Not used is an Admin concept and stays one (#977 §15)', () => {
  const API_SRC = join(__dirname, '..');
  const MEMBER_SRC = join(API_SRC, '..', '..', 'apps', 'member', 'src');

  it('keeps the two routers that report it out of a member\'s reach', () => {
    // `/class-sessions` and `/calendar-events` are both mounted behind
    // `requireModuleAccess('CALENDAR')`, and a member has none of it — which
    // is what makes "members should not see that an unused slot existed" a
    // property of the permission matrix rather than of each read.
    expect(PERMISSION_MATRIX.CALENDAR.member).toBe('NONE');
  });

  it('never answers not_used from the member-facing lifecycle', () => {
    // `computeCalendarEventStatus()` (#503 stage 5) is the member's own
    // vocabulary — scheduled / running / completed / cancelled. A fifth value
    // added there would put an operational state on a member's calendar, which
    // is the half of this rule #976 §2/§6/§7 already settled.
    const me = readFileSync(join(API_SRC, 'api', 'me.ts'), 'utf-8');
    expect(me).not.toContain('not_used');
    expect(me).not.toContain('execution_status');
  });

  it('is named nowhere in the Members app', () => {
    // CI runs `npm test` in api/ only, so the member app is scanned from here
    // (the same arrangement as the migration-074 gate).
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        const text = readFileSync(full, 'utf-8');
        if (text.includes('not_used') || text.includes('execution_status')) offenders.push(full);
      }
    };
    walk(MEMBER_SRC);
    expect(offenders, `the Members app names an Admin execution status: ${offenders.join(', ')}`).toEqual([]);
  });
});
