// Unit tests for the #647 stage 4 alerting rules — pure functions, no DB
// dependency (the run itself, its SQL and its rate limit live in
// api/src/api/recurring-bookings.ts, covered by the integration suite in
// recurring-booking-run.test.ts).
//
// One decision is made here and nowhere else: given what a night's booking pass
// did, which dates is the Member told about? The thread's Q5 answer is the
// spec — "the night scheduler […] can publish an alert into the membership app
// informing that the booking on May 1st could not be completed because it is a
// festivity or the gym is closed or it was already booked by another event" —
// and the hard part is not choosing the reasons but *not repeating* an alert:
// the window is rolling, so the same closed Monday is re-examined on every one
// of the ~60 runs before it passes.

import { describe, expect, it } from 'vitest';
import {
  NOTIFIED_SKIP_REASONS,
  planSkipNotifications,
  skipNotificationKey,
  slotIdentityKey,
  type BookingResult,
  type SlotIdentity,
  type SlotRunReport,
  type WeeklySlot,
} from '../domain/personalTrainingSlots';

const MONDAY: SlotIdentity = {
  weekday: 1,
  start_time: '10:00',
  end_time: '11:00',
  activity_type_id: 7,
  professional_service_id: 3,
  center_id: null,
};

const WEDNESDAY: SlotIdentity = { ...MONDAY, weekday: 3, start_time: '12:00', end_time: '13:00' };

const MONDAY_KEY = slotIdentityKey(MONDAY);
const WEDNESDAY_KEY = slotIdentityKey(WEDNESDAY);

/** A projected slot carrying only the fields the alert copies out of it. */
function slotOf(identity: SlotIdentity): WeeklySlot {
  return {
    ...identity,
    professional_service_name: 'Personal Training',
    activity_type_name: 'PT 1:1',
    center_name: null,
    dates: [],
    occurrence_count: 0,
    available_count: 0,
    already_booked_count: 0,
    fully_available: false,
    selected: true,
  };
}

function result(
  date: string,
  outcome: BookingResult['outcome'],
  reason?: string,
  calendarEventId: number | null = 900,
): BookingResult {
  return { date, calendar_event_id: calendarEventId, outcome, reason };
}

function report(identity: SlotIdentity, results: BookingResult[], matched = true): SlotRunReport {
  return { selection: identity, slot: matched ? slotOf(identity) : null, results };
}

describe('planSkipNotifications — which dates the Member hears about', () => {
  it('alerts on a date with no scheduled occurrence (a holiday or a closed gym)', () => {
    const out = planSkipNotifications(
      [report(MONDAY, [result('2026-05-01', 'skipped', 'no_occurrence', null)])],
      new Set(),
    );

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      date: '2026-05-01',
      reason: 'no_occurrence',
      calendar_event_id: null,
      slot_key: MONDAY_KEY,
      weekday: 1,
      start_time: '10:00',
      end_time: '11:00',
      professional_service_name: 'Personal Training',
      activity_type_name: 'PT 1:1',
    });
  });

  it('alerts on a date taken by someone else, keeping the occurrence id', () => {
    const out = planSkipNotifications(
      [report(MONDAY, [result('2026-05-04', 'skipped', 'full', 412)])],
      new Set(),
    );

    expect(out).toHaveLength(1);
    expect(out[0].reason).toBe('full');
    expect(out[0].calendar_event_id).toBe(412);
  });

  it('alerts on a cancelled occurrence', () => {
    const out = planSkipNotifications(
      [report(MONDAY, [result('2026-05-11', 'skipped', 'not_scheduled')])],
      new Set(),
    );

    expect(out.map((n) => n.reason)).toEqual(['not_scheduled']);
  });

  it('covers exactly the reasons the ticket names, and no others', () => {
    // A guard on the constant itself: adding a reason to the union without
    // meaning to would start notifying Members about it.
    expect([...NOTIFIED_SKIP_REASONS]).toEqual(['no_occurrence', 'not_scheduled', 'full']);
  });

  it('says nothing about a date the Member already holds', () => {
    // The desired outcome, not a disappointment — and on a rolling window it
    // would otherwise fire every night for every booked date.
    const out = planSkipNotifications(
      [report(MONDAY, [result('2026-05-04', 'skipped', 'already_booked')])],
      new Set(),
    );

    expect(out).toEqual([]);
  });

  it('says nothing about a booked date or an internal failure', () => {
    const out = planSkipNotifications(
      [report(MONDAY, [
        result('2026-05-04', 'booked'),
        result('2026-05-11', 'failed', 'ER_LOCK_DEADLOCK'),
      ])],
      new Set(),
    );

    expect(out).toEqual([]);
  });

  it('ignores a skip with no reason at all', () => {
    const out = planSkipNotifications([report(MONDAY, [result('2026-05-04', 'skipped')])], new Set());
    expect(out).toEqual([]);
  });
});

describe('planSkipNotifications — not telling the Member twice', () => {
  it('drops a date the Member has already been alerted about', () => {
    const results = [
      result('2026-05-01', 'skipped', 'no_occurrence', null),
      result('2026-05-08', 'skipped', 'full'),
    ];
    const alreadySent = new Set([skipNotificationKey(MONDAY_KEY, '2026-05-01')]);

    const out = planSkipNotifications([report(MONDAY, results)], alreadySent);

    expect(out.map((n) => n.date)).toEqual(['2026-05-08']);
  });

  it('is a no-op once every date has been alerted — the steady state of a rolling window', () => {
    const results = [
      result('2026-05-01', 'skipped', 'no_occurrence', null),
      result('2026-05-08', 'skipped', 'full'),
    ];
    const alreadySent = new Set([
      skipNotificationKey(MONDAY_KEY, '2026-05-01'),
      skipNotificationKey(MONDAY_KEY, '2026-05-08'),
    ]);

    expect(planSkipNotifications([report(MONDAY, results)], alreadySent)).toEqual([]);
  });

  it('does not re-alert when a date changes reason', () => {
    // Keyed on (slot, date), not (slot, date, reason): a date that was `full`
    // last night and is `not_scheduled` tonight is the same disappointment, and
    // keying on the reason would reintroduce the nightly flood for any
    // occurrence whose status wobbles.
    const alreadySent = new Set([skipNotificationKey(MONDAY_KEY, '2026-05-08')]);

    const out = planSkipNotifications(
      [report(MONDAY, [result('2026-05-08', 'skipped', 'not_scheduled')])],
      alreadySent,
    );

    expect(out).toEqual([]);
  });

  it('keeps the same date on two different slots apart', () => {
    // A Monday and a Wednesday selection can never share a date, but two slots
    // at different times on the same weekday can — and each deserves its alert.
    const evening: SlotIdentity = { ...MONDAY, start_time: '19:00', end_time: '20:00' };
    const out = planSkipNotifications(
      [
        report(MONDAY, [result('2026-05-04', 'skipped', 'full')]),
        report(evening, [result('2026-05-04', 'skipped', 'full')]),
      ],
      new Set(),
    );

    expect(out).toHaveLength(2);
    expect(new Set(out.map((n) => n.slot_key)).size).toBe(2);
  });

  it('deduplicates within a single run', () => {
    // Defensive: the same date should not appear twice in one slot's results,
    // but one alert per (slot, date) is the invariant the dedupe store relies
    // on — a duplicated row would be re-sent forever, since the reader folds
    // them back into one key.
    const out = planSkipNotifications(
      [report(MONDAY, [
        result('2026-05-04', 'skipped', 'full'),
        result('2026-05-04', 'skipped', 'no_occurrence', null),
      ])],
      new Set(),
    );

    expect(out).toHaveLength(1);
    expect(out[0].reason).toBe('full');
  });
});

describe('planSkipNotifications — shape of the output', () => {
  it('reports a slot the grid no longer offers with null names (§5)', () => {
    // The Member lost the Professional Service: `planSlotBookings` produces no
    // dates at all for it, so in practice there is nothing to alert — but a
    // caller that does pass results must not crash on the missing slot.
    const out = planSkipNotifications(
      [report(MONDAY, [result('2026-05-04', 'skipped', 'full')], false)],
      new Set(),
    );

    expect(out).toHaveLength(1);
    expect(out[0].professional_service_name).toBeNull();
    expect(out[0].activity_type_name).toBeNull();
  });

  it('orders alerts by date, then slot', () => {
    const out = planSkipNotifications(
      [
        report(MONDAY, [result('2026-05-11', 'skipped', 'full'), result('2026-05-04', 'skipped', 'full')]),
        report(WEDNESDAY, [result('2026-05-06', 'skipped', 'no_occurrence', null)]),
      ],
      new Set(),
    );

    expect(out.map((n) => n.date)).toEqual(['2026-05-04', '2026-05-06', '2026-05-11']);
    expect(out[1].slot_key).toBe(WEDNESDAY_KEY);
  });

  it('returns nothing for a Member with no selections at all', () => {
    expect(planSkipNotifications([], new Set())).toEqual([]);
  });

  it('leaves the caller’s set of sent keys untouched', () => {
    // The run reads the stored keys once per Member; mutating the caller's set
    // would be a surprise, and the set is reused when the report is built.
    const alreadySent = new Set([skipNotificationKey(MONDAY_KEY, '2026-05-01')]);

    planSkipNotifications([report(MONDAY, [result('2026-05-08', 'skipped', 'full')])], alreadySent);

    expect([...alreadySent]).toEqual([skipNotificationKey(MONDAY_KEY, '2026-05-01')]);
  });
});

describe('skipNotificationKey', () => {
  it('identifies one alert per slot and date', () => {
    expect(skipNotificationKey(MONDAY_KEY, '2026-05-04')).toBe(`${MONDAY_KEY}@2026-05-04`);
    expect(skipNotificationKey(MONDAY_KEY, '2026-05-04')).not.toBe(
      skipNotificationKey(WEDNESDAY_KEY, '2026-05-04'),
    );
  });
});
