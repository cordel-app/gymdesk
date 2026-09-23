// Unit tests for the #647 stage 2 weekly availability projection — pure
// functions, no DB dependency (the SQL that feeds them lives in
// api/src/api/member-personal-training-slots.ts).
//
// Fixed dates are safe here precisely because the module is pure: `from` and
// `to` are inputs, not `now`.

import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import {
  expectedSlotDates,
  projectWeeklySlots,
  type SlotOccurrenceRow,
  type WeeklySlot,
} from '../domain/personalTrainingSlots';

const TZ = 'Europe/Madrid';

/** A UTC datetime string as mysql2 hands it back (timezone:'Z'). */
function utc(dateTime: string): string {
  return dateTime;
}

function occurrence(overrides: Partial<SlotOccurrenceRow> = {}): SlotOccurrenceRow {
  return {
    calendar_event_id: 1,
    // 2026-03-02 is a Monday. 09:00Z = 10:00 Europe/Madrid (CET, winter).
    starts_at: utc('2026-03-02 09:00:00'),
    ends_at: utc('2026-03-02 10:00:00'),
    status: 'scheduled',
    activity_type_id: 7,
    activity_type_name: 'Personal Training',
    professional_service_id: 3,
    professional_service_name: 'Personal Training',
    center_id: null,
    center_name: null,
    effective_capacity: 1,
    booked_count: 0,
    member_booked: 0,
    ...overrides,
  };
}

/**
 * Mondays 10:00–11:00 *gym-local* starting 2026-03-02, converted to UTC the
 * way `materializeScheduleRule` writes them. Built in local time on purpose:
 * a fixed UTC time would drift to 11:00 local after Europe/Madrid moves to
 * CEST on 2026-03-29, which is a different slot — the DST case has its own
 * test below.
 */
function mondaySeries(count: number, overrides: (i: number) => Partial<SlotOccurrenceRow> = () => ({})): SlotOccurrenceRow[] {
  const first = DateTime.fromISO('2026-03-02T10:00:00', { zone: TZ });
  return Array.from({ length: count }, (_, i) => {
    const start = first.plus({ weeks: i }).toUTC();
    return occurrence({
      calendar_event_id: 100 + i,
      starts_at: start.toFormat('yyyy-MM-dd HH:mm:ss'),
      ends_at: start.plus({ hours: 1 }).toFormat('yyyy-MM-dd HH:mm:ss'),
      ...overrides(i),
    });
  });
}

function project(occurrences: SlotOccurrenceRow[], opts: {
  from?: DateTime; to?: DateTime; eligible?: Set<number>;
} = {}) {
  const from = opts.from ?? DateTime.fromISO('2026-03-01T00:00:00', { zone: TZ });
  return projectWeeklySlots({
    timezone: TZ,
    from,
    to: opts.to ?? from.plus({ months: 2 }),
    occurrences,
    eligibleActivityTypeIds: opts.eligible ?? new Set([7]),
  });
}

/** The single slot a one-slot projection produced. */
function onlySlot(days: ReturnType<typeof project>): WeeklySlot {
  const slots = days.flatMap((d) => d.slots);
  expect(slots).toHaveLength(1);
  return slots[0];
}

describe('expectedSlotDates', () => {
  it('lists every matching weekday inside the window', () => {
    const from = DateTime.fromISO('2026-03-01T00:00:00', { zone: TZ }); // Sunday
    const dates = expectedSlotDates(1, '10:00', from, from.plus({ weeks: 3 }));
    expect(dates).toEqual(['2026-03-02', '2026-03-09', '2026-03-16']);
  });

  it('skips today when the slot time has already passed', () => {
    // Monday 11:30 local — the 10:00 slot is behind us, the next one is a week out.
    const from = DateTime.fromISO('2026-03-02T11:30:00', { zone: TZ });
    const dates = expectedSlotDates(1, '10:00', from, from.plus({ weeks: 2 }));
    expect(dates[0]).toBe('2026-03-09');
  });

  it('keeps today when the slot time is still ahead', () => {
    const from = DateTime.fromISO('2026-03-02T08:00:00', { zone: TZ });
    const dates = expectedSlotDates(1, '10:00', from, from.plus({ weeks: 2 }));
    expect(dates[0]).toBe('2026-03-02');
  });
});

describe('projectWeeklySlots', () => {
  it('returns all seven weekdays, Monday first, even with no occurrences', () => {
    const days = project([]);
    expect(days.map((d) => d.weekday)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(days.every((d) => d.slots.length === 0)).toBe(true);
  });

  it('collapses a weekly series into one recurring slot in gym-local time', () => {
    const slot = onlySlot(project(mondaySeries(9)));
    expect(slot).toMatchObject({
      weekday: 1,
      start_time: '10:00', // 09:00Z rendered in Europe/Madrid
      end_time: '11:00',
      professional_service_id: 3,
      activity_type_id: 7,
      fully_available: true,
    });
    expect(slot.occurrence_count).toBe(slot.available_count);
  });

  it('keeps the slot when a single date is full, and says how many are free', () => {
    // Q5 on the issue thread: a taken date is silently ignored, not a reason
    // to erase the whole weekday from the grid.
    const slot = onlySlot(project(mondaySeries(9, (i) => (i === 2 ? { booked_count: 1 } : {}))));
    expect(slot.fully_available).toBe(false);
    expect(slot.available_count).toBe(slot.occurrence_count - 1);
    expect(slot.dates.filter((d) => d.status === 'full')).toHaveLength(1);
  });

  it('reports a date with no occurrence rather than shortening the list', () => {
    // A closure / a rule that ends early: eight of the nine Mondays exist.
    const series = mondaySeries(9).filter((_, i) => i !== 4);
    const slot = onlySlot(project(series));
    expect(slot.occurrence_count).toBe(9);
    const missing = slot.dates.filter((d) => d.status === 'no_occurrence');
    expect(missing).toHaveLength(1);
    expect(missing[0].calendar_event_id).toBeNull();
  });

  it('marks cancelled occurrences as not bookable', () => {
    const slot = onlySlot(project(mondaySeries(9, (i) => (i === 0 ? { status: 'cancelled' } : {}))));
    expect(slot.dates[0].status).toBe('not_scheduled');
    expect(slot.available_count).toBe(slot.occurrence_count - 1);
  });

  it("counts the Member's own bookings separately from free dates", () => {
    const slot = onlySlot(project(mondaySeries(9, (i) => (i < 2 ? { member_booked: 1 } : {}))));
    expect(slot.already_booked_count).toBe(2);
    expect(slot.available_count).toBe(slot.occurrence_count - 2);
    expect(slot.fully_available).toBe(false);
  });

  it('treats a full occurrence the Member already holds as already_booked', () => {
    // Their own booking is why it is full — reporting 'full' would read as
    // "someone else took it".
    const slot = onlySlot(project(mondaySeries(1, () => ({ booked_count: 1, member_booked: 1 }))));
    expect(slot.dates[0].status).toBe('already_booked');
  });

  it('does not read a null capacity as full', () => {
    const slot = onlySlot(project(mondaySeries(1, () => ({ effective_capacity: null, booked_count: 3 }))));
    expect(slot.dates[0].status).toBe('available');
  });

  it('drops Activity Types the Member may not book (#481)', () => {
    expect(project(mondaySeries(9), { eligible: new Set<number>() }).flatMap((d) => d.slots)).toEqual([]);
  });

  it('keeps two different times on the same weekday as separate slots', () => {
    const morning = mondaySeries(2);
    const evening = mondaySeries(2).map((o, i) => ({
      ...o,
      calendar_event_id: 200 + i,
      starts_at: String(o.starts_at).replace('09:00:00', '16:00:00'),
      ends_at: String(o.ends_at).replace('10:00:00', '17:00:00'),
    }));
    const slots = project([...morning, ...evening]).flatMap((d) => d.slots);
    expect(slots.map((s) => s.start_time)).toEqual(['10:00', '17:00']);
  });

  it('keeps the same time on the same weekday apart per Professional Service', () => {
    const pt = mondaySeries(2);
    const physio = mondaySeries(2).map((o, i) => ({
      ...o,
      calendar_event_id: 300 + i,
      activity_type_id: 8,
      activity_type_name: 'Physiotherapy',
      professional_service_id: 4,
      professional_service_name: 'Physiotherapy',
    }));
    const slots = project([...pt, ...physio], { eligible: new Set([7, 8]) }).flatMap((d) => d.slots);
    expect(slots).toHaveLength(2);
    expect(slots.map((s) => s.professional_service_name)).toEqual(['Personal Training', 'Physiotherapy']);
  });

  it('keeps the same activity at the same time in two centers as separate slots', () => {
    // Collapsing them would discard one center's occurrences entirely: only
    // the first row per date survives the byDate map.
    const centerA = mondaySeries(2).map((o) => ({ ...o, center_id: 1, center_name: 'Downtown' }));
    const centerB = mondaySeries(2).map((o, i) => ({
      ...o, calendar_event_id: 500 + i, center_id: 2, center_name: 'Uptown',
    }));
    const slots = project([...centerA, ...centerB]).flatMap((d) => d.slots);
    expect(slots).toHaveLength(2);
    expect(slots.map((s) => s.center_name)).toEqual(['Downtown', 'Uptown']);
    expect(slots.every((s) => s.available_count === 2)).toBe(true);
  });

  it('ignores occurrences outside the window', () => {
    const from = DateTime.fromISO('2026-03-01T00:00:00', { zone: TZ });
    // 12 Mondays overshoot a 2-month window; only the ones inside it count.
    const slot = onlySlot(project(mondaySeries(12), { from, to: from.plus({ months: 2 }) }));
    expect(slot.occurrence_count).toBeLessThan(12);
    expect(slot.dates.every((d) => d.date >= '2026-03-01' && d.date < '2026-05-01')).toBe(true);
  });

  it('groups a DST-crossing series as one slot at the same local time', () => {
    // Europe/Madrid moves to CEST on 2026-03-29, so the same 10:00 local slot
    // is 09:00Z before and 08:00Z after. Grouping on UTC would split it in two.
    const before = mondaySeries(4); // 2026-03-02 … 2026-03-23, 09:00Z
    const after = [0, 1, 2].map((i) => {
      const start = DateTime.fromISO('2026-03-30T08:00:00', { zone: 'utc' }).plus({ weeks: i });
      return occurrence({
        calendar_event_id: 400 + i,
        starts_at: start.toFormat('yyyy-MM-dd HH:mm:ss'),
        ends_at: start.plus({ hours: 1 }).toFormat('yyyy-MM-dd HH:mm:ss'),
      });
    });
    const slot = onlySlot(project([...before, ...after]));
    expect(slot.start_time).toBe('10:00');
    expect(slot.dates.filter((d) => d.status === 'available').length).toBe(7);
  });

  it('counts a duplicate occurrence on the same date only once', () => {
    const [first] = mondaySeries(1);
    const duplicate = { ...first, calendar_event_id: 999 };
    const slot = onlySlot(project([first, duplicate]));
    // The window still expects every Monday — only one of them is scheduled.
    expect(slot.available_count).toBe(1);
    expect(slot.dates[0].calendar_event_id).toBe(first.calendar_event_id);
    expect(slot.dates.slice(1).every((d) => d.status === 'no_occurrence')).toBe(true);
  });
});
