import { describe, expect, it } from 'vitest';
import {
  CANCELLATION_GRACE_HOURS,
  CANCELLATION_NOTICE_HOURS,
  decideMemberCancellation,
} from '../domain/bookingCancellation';
import { memberCancellation, withoutCancellationTiming } from '../api/booking-cancellation';

// #1162 — the member cancellation rule, pure. The four worked examples are the
// ticket's own (§4), with the clock expressed as the two numbers the SQL hands
// the decider: seconds until the event starts, seconds since the booking.

const H = 3600;

describe('decideMemberCancellation (#1162 §2–§4)', () => {
  it('declares the two durations the copy says out loud', () => {
    expect(CANCELLATION_NOTICE_HOURS).toBe(24);
    expect(CANCELLATION_GRACE_HOURS).toBe(2);
  });

  it('Example 1 — same-day booking inside the grace period is cancellable', () => {
    // Event in 1 hour, booked 30 minutes ago.
    expect(decideMemberCancellation({ status: 'booked', secondsUntilStart: 1 * H, secondsSinceBooked: 0.5 * H }))
      .toEqual({ allowed: true, block: null });
  });

  it('Example 2 — same-day booking with the grace period spent is refused', () => {
    // Event in 1h30, booked 2h30 ago.
    expect(decideMemberCancellation({ status: 'booked', secondsUntilStart: 1.5 * H, secondsSinceBooked: 2.5 * H }))
      .toEqual({ allowed: false, block: 'window_closed' });
  });

  it('Example 3 — an event 24 hours or more away is cancellable whenever it was booked', () => {
    expect(decideMemberCancellation({ status: 'booked', secondsUntilStart: 30 * H, secondsSinceBooked: 2 * H }))
      .toEqual({ allowed: true, block: null });
    expect(decideMemberCancellation({ status: 'booked', secondsUntilStart: 24 * H, secondsSinceBooked: 400 * H }))
      .toEqual({ allowed: true, block: null });
  });

  it('Example 4 — both conditions true is cancellable', () => {
    expect(decideMemberCancellation({ status: 'booked', secondsUntilStart: 41 * H, secondsSinceBooked: 1 * H }))
      .toEqual({ allowed: true, block: null });
  });

  it('compares the timestamps, not the calendar dates (§3)', () => {
    // 23h59m59s away with a 2h-old booking: inside the window, refused — the
    // event being "tomorrow" on the calendar is not the question.
    expect(decideMemberCancellation({ status: 'booked', secondsUntilStart: 24 * H - 1, secondsSinceBooked: 2 * H }))
      .toEqual({ allowed: false, block: 'window_closed' });
    // Exactly 2 hours old is no longer "less than 2 hours ago".
    expect(decideMemberCancellation({ status: 'booked', secondsUntilStart: 5 * H, secondsSinceBooked: 2 * H }))
      .toEqual({ allowed: false, block: 'window_closed' });
    expect(decideMemberCancellation({ status: 'booked', secondsUntilStart: 5 * H, secondsSinceBooked: 2 * H - 1 }))
      .toEqual({ allowed: true, block: null });
  });

  it('refuses a booking whose event has started, whatever its age', () => {
    expect(decideMemberCancellation({ status: 'booked', secondsUntilStart: 0, secondsSinceBooked: 60 }))
      .toEqual({ allowed: false, block: 'already_started' });
    expect(decideMemberCancellation({ status: 'waitlisted', secondsUntilStart: -600, secondsSinceBooked: null }))
      .toEqual({ allowed: false, block: 'already_started' });
  });

  it('treats a waiting-list place as leavable until the event starts — it is not a booking', () => {
    expect(decideMemberCancellation({ status: 'waitlisted', secondsUntilStart: 1 * H, secondsSinceBooked: null }))
      .toEqual({ allowed: true, block: null });
    expect(decideMemberCancellation({ status: null, secondsUntilStart: 1 * H, secondsSinceBooked: null }))
      .toEqual({ allowed: true, block: null });
  });

  it('gives a legacy booking with no booked_at no grace period rather than an invented one', () => {
    expect(decideMemberCancellation({ status: 'booked', secondsUntilStart: 5 * H, secondsSinceBooked: null }))
      .toEqual({ allowed: false, block: 'window_closed' });
    expect(decideMemberCancellation({ status: 'booked', secondsUntilStart: 25 * H, secondsSinceBooked: null }))
      .toEqual({ allowed: true, block: null });
  });
});

describe('memberCancellation — the row shape every read and the DELETE use', () => {
  it('reads mysql2 numbers and strings alike, and NULL as no booked_at', () => {
    expect(memberCancellation({ status: 'booked', seconds_until_start: '5400', seconds_since_booked: '1800' }))
      .toEqual({ can_cancel: true, cancellation_block: null });
    expect(memberCancellation({ status: 'booked', seconds_until_start: 5400, seconds_since_booked: null }))
      .toEqual({ can_cancel: false, cancellation_block: 'window_closed' });
    // The status may come from a correlated subquery rather than the row.
    expect(memberCancellation({ seconds_until_start: 5400, seconds_since_booked: null }, 'waitlisted'))
      .toEqual({ can_cancel: true, cancellation_block: null });
  });

  it('strips the two helper columns before a row reaches the client', () => {
    expect(withoutCancellationTiming({ id: 1, seconds_until_start: 5, seconds_since_booked: 6, booked_on: 'x' }))
      .toEqual({ id: 1, booked_on: 'x' });
  });
});
