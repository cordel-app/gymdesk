import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { getCalendarEventStatusBadgeColors, DEFAULT_STATUS_BADGE_COLORS } from '../lib/calendarEventColors';

// #977 — the Admin app's half of the event execution status.
//
// The rule itself lives on the server (`api/src/domain/eventExecutionStatus.ts`,
// unit-tested there); what these tests guard is that the Admin app *reports*
// it rather than deciding it again, that the status never reaches the event's
// colour, and that `Mark as completed` is offered only where the ticket says.

const SRC = join(__dirname, '..');
const calendarPage = readFileSync(join(SRC, 'app', '[locale]', 'calendar', 'page.tsx'), 'utf-8');
const sessionPanel = readFileSync(join(SRC, 'app', '[locale]', 'calendar', 'ClassSessionDetailPanel.tsx'), 'utf-8');

const LOCALES_DIR = join(SRC, '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

const NEW_KEYS = [
  'status_not_used',
  'waitlist_count',
  'mark_completed',
  'marking_completed',
  'mark_completed_confirm_title',
  'mark_completed_confirm_message',
  'complete_blocked_attendance',
  'complete_blocked_trainer',
] as const;

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('The execution status is read, not re-derived (#977)', () => {
  it('takes the badge status from the API field', () => {
    expect(calendarPage).toContain('e.execution_status');
    expect(sessionPanel).toContain('session.execution_status');
  });

  it('never decides `not_used` in the browser', () => {
    // The whole point of deriving it server-side: the calendar, the session
    // panel and any later report answer the same way. A page that compared
    // `ends_at` against the clock and counted bookings itself would be the
    // second place deciding what an unused slot is.
    for (const [name, source] of [['the calendar page', calendarPage], ['the session panel', sessionPanel]] as const) {
      // A comparison against the API's value is the point; an *assignment* of
      // it, or a literal written into a row, would be the browser deciding.
      expect(stripComments(source), `${name} assigns 'not_used' itself`)
        .not.toMatch(/(?<![=!<>])=\s*'not_used'/);
    }
  });

  it('keeps `full` able to override only a scheduled session', () => {
    // `full` is the one status the UI still derives (capacity), and since #977
    // it is gated on the *execution* status — otherwise a past, empty session
    // at capacity 0 could read `Full` instead of `Not used`.
    expect(calendarPage).toMatch(/isFull[\s\S]{0,200}executionStatus === 'scheduled'/);
    expect(calendarPage).toMatch(/isFull\s*\?\s*'full'/);
  });
});

describe('Status never becomes the event colour (#977 §8)', () => {
  it('sets no per-event background or border on the admin calendar', () => {
    // FullCalendar writes these as inline styles, which beat the theme's
    // Calendar tokens (#559 stage 3) — and the ticket's own §8 is that the
    // execution status must never change what an event is painted with.
    // Whether an admin event should instead take its configured
    // activity/event colour is #975's open question, not this one's.
    expect(calendarPage).not.toMatch(/^\s*backgroundColor:/m);
    expect(calendarPage).not.toMatch(/^\s*borderColor:/m);
  });

  it("gives not_used the palette's existing neutral tone rather than a new hue", () => {
    // §8 rules out inventing yellow/green/red/orange for these statuses
    // unless they already exist in the app's status system. `not_used` is the
    // absence of an outcome, so it shares `draft`'s neutral pair.
    const notUsed = getCalendarEventStatusBadgeColors('not_used');
    expect(notUsed).toEqual(getCalendarEventStatusBadgeColors('draft'));
    expect(notUsed).not.toEqual(DEFAULT_STATUS_BADGE_COLORS);
  });

  it('declares no colour of its own in either surface', () => {
    // The session panel's status row borrows the calendar's badge instead of
    // the red CANCELLED line it used to print.
    expect(sessionPanel).toContain('CalendarStatusBadge');
    expect(stripComments(sessionPanel)).not.toContain('CANCELLED');
  });
});

describe('Mark as completed (#977 §4/§11)', () => {
  it('is offered only after the event has ended and only while unconfirmed', () => {
    // §2 — a future event asks nothing of the teacher; §3 — an empty slot that
    // passed needs no confirmation either, though §5 allows one deliberately.
    expect(sessionPanel).toMatch(/canMarkCompleted\s*=\s*canWrite && hasEnded/);
    expect(sessionPanel).toMatch(/executionStatus === 'scheduled' \|\| executionStatus === 'not_used'/);
    expect(sessionPanel).toContain('hasEnded');
  });

  it('asks for confirmation before posting', () => {
    expect(sessionPanel).toContain('showCompleteConfirm');
    expect(sessionPanel).toContain("mark_completed_confirm_title");
    expect(sessionPanel).toMatch(/\/complete`, \{ method: 'POST' \}/);
  });

  it("turns the route's refusals into something actionable", () => {
    // The 400 names `pending_count` / `missing_trainer`; a generic toast would
    // leave the teacher with no idea what to do next.
    expect(sessionPanel).toContain('missing_trainer');
    expect(sessionPanel).toContain('pending_count');
  });

  it('writes no status of its own', () => {
    // The panel posts to the action route; it never PUTs a status, so the
    // audit row and `modified_by_membership_id` are always written.
    expect(sessionPanel).not.toMatch(/status:\s*'completed'/);
  });
});

describe('Locale coverage for the new strings (#977)', () => {
  it('has every key in every locale', () => {
    // next-intl has no locale fallback and no `defaultValue` option, so a
    // missing key renders as its raw dotted path on screen.
    for (const code of LOCALE_CODES) {
      const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
      for (const key of NEW_KEYS) {
        const value = messages.calendar?.[key];
        expect(value, `${code}.json is missing calendar.${key}`).toBeTypeOf('string');
        expect((value as string).length).toBeGreaterThan(0);
      }
    }
  });

  it('interpolates the counts it promises', () => {
    for (const code of LOCALE_CODES) {
      const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
      expect(messages.calendar.waitlist_count).toContain('{count}');
      expect(messages.calendar.complete_blocked_attendance).toContain('{count, plural,');
    }
  });

  it('says Completed rather than Held (§1)', () => {
    const en = JSON.parse(readFileSync(join(LOCALES_DIR, 'en.json'), 'utf-8'));
    expect(en.calendar.status_completed).toBe('Completed');
    expect(en.calendar.status_not_used).toBe('Not used');
    expect(JSON.stringify(en.calendar)).not.toMatch(/\bHeld\b/);
  });
});
