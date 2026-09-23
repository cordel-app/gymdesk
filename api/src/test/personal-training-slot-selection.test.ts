// Unit tests for the #647 stage 3 selection rules — pure functions, no DB
// dependency (the SQL and the booking path live in
// api/src/api/member-personal-training-slots.ts, covered by the integration
// suite in member-personal-training-slots.test.ts).
//
// Three things are decided here and nowhere else:
//   - `parseSlotIdentities`  — what a PUT /selections body may contain.
//   - `projectWeeklySlots({ selectedKeys })` — which grid slots read as picked.
//   - `planSlotBookings`     — which dates of a stored weekly pattern the Book
//                              action hands to `bookMemberOnSession`, and what
//                              it reports for the rest.
//
// Fixed dates are safe because the module is pure: `from`/`to` are inputs.

import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import {
  parseSlotIdentities,
  planSlotBookings,
  projectWeeklySlots,
  slotIdentityKey,
  type SlotIdentity,
  type SlotOccurrenceRow,
  type WeeklySlot,
  type WeeklySlotDay,
} from '../domain/personalTrainingSlots';

const TZ = 'Europe/Madrid';
/** 2026-03-01 is a Sunday; the series below starts on Monday 2026-03-02. */
const FROM = DateTime.fromISO('2026-03-01T00:00:00', { zone: TZ });

const IDENTITY: SlotIdentity = {
  weekday: 1,
  start_time: '10:00',
  end_time: '11:00',
  activity_type_id: 7,
  professional_service_id: 3,
  center_id: null,
};

function occurrence(overrides: Partial<SlotOccurrenceRow> = {}): SlotOccurrenceRow {
  return {
    calendar_event_id: 1,
    starts_at: '2026-03-02 09:00:00', // 10:00 Europe/Madrid (CET)
    ends_at: '2026-03-02 10:00:00',
    status: 'scheduled',
    activity_type_id: 7,
    activity_type_name: 'Personal Training',
    professional_service_id: 3,
    professional_service_name: 'Personal Training',
    center_id: null,
    center_name: null,
    effective_capacity: 2,
    booked_count: 0,
    member_booked: 0,
    ...overrides,
  };
}

/** Mondays 10:00–11:00 *gym-local*, converted to UTC as the scheduler writes them. */
function mondaySeries(
  count: number,
  overrides: (i: number) => Partial<SlotOccurrenceRow> = () => ({}),
): SlotOccurrenceRow[] {
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

function project(occurrences: SlotOccurrenceRow[], selected: SlotIdentity[] = []): WeeklySlotDay[] {
  return projectWeeklySlots({
    timezone: TZ,
    from: FROM,
    to: FROM.plus({ weeks: 4 }),
    occurrences,
    eligibleActivityTypeIds: new Set([7]),
    selectedKeys: new Set(selected.map(slotIdentityKey)),
  });
}

function onlySlot(days: WeeklySlotDay[]): WeeklySlot {
  const slots = days.flatMap((d) => d.slots);
  expect(slots).toHaveLength(1);
  return slots[0];
}

describe('parseSlotIdentities', () => {
  const valid = {
    weekday: 1,
    start_time: '10:00',
    end_time: '11:00',
    activity_type_id: 7,
    professional_service_id: 3,
  };

  it('accepts a well-formed entry and defaults center_id to null', () => {
    const result = parseSlotIdentities([valid]);
    expect(result).toEqual({ slots: [IDENTITY] });
  });

  it('trims HH:MM:SS times to the HH:MM the projection groups on', () => {
    const result = parseSlotIdentities([{ ...valid, start_time: '10:00:00', end_time: '11:00:00' }]);
    expect('slots' in result && result.slots[0].start_time).toBe('10:00');
    expect('slots' in result && result.slots[0].end_time).toBe('11:00');
  });

  it('accepts an explicit center_id', () => {
    const result = parseSlotIdentities([{ ...valid, center_id: 4 }]);
    expect('slots' in result && result.slots[0].center_id).toBe(4);
  });

  it('accepts an empty array — that is how every slot is deselected', () => {
    expect(parseSlotIdentities([])).toEqual({ slots: [] });
  });

  it('drops a repeated identity rather than failing the whole request', () => {
    const result = parseSlotIdentities([valid, { ...valid }]);
    expect('slots' in result && result.slots).toHaveLength(1);
  });

  it('keeps two slots that differ only by center', () => {
    const result = parseSlotIdentities([{ ...valid, center_id: 4 }, { ...valid, center_id: 5 }]);
    expect('slots' in result && result.slots).toHaveLength(2);
  });

  it.each([
    ['a non-array body', 'not-an-array'],
    ['a non-object entry', [5]],
  ])('rejects %s', (_label, body) => {
    expect(parseSlotIdentities(body)).toHaveProperty('error');
  });

  it.each([
    ['weekday 0', { ...valid, weekday: 0 }],
    ['weekday 8', { ...valid, weekday: 8 }],
    ['a non-integer weekday', { ...valid, weekday: 1.5 }],
    ['a malformed time', { ...valid, start_time: '25:00' }],
    ['a missing time', { ...valid, end_time: undefined }],
    ['end_time equal to start_time', { ...valid, end_time: '10:00' }],
    ['end_time before start_time', { ...valid, end_time: '09:00' }],
    ['a zero activity_type_id', { ...valid, activity_type_id: 0 }],
    ['a negative professional_service_id', { ...valid, professional_service_id: -3 }],
    ['a non-integer center_id', { ...valid, center_id: 'x' }],
  ])('rejects %s', (_label, entry) => {
    const result = parseSlotIdentities([entry]);
    expect(result).toHaveProperty('error');
  });
});

describe('projectWeeklySlots — selected flag', () => {
  it('marks a slot the Member has stored', () => {
    const slot = onlySlot(project(mondaySeries(3), [IDENTITY]));
    expect(slot.selected).toBe(true);
  });

  it('leaves selected false when nothing is stored', () => {
    expect(onlySlot(project(mondaySeries(3))).selected).toBe(false);
  });

  it('does not match a stored slot at a different time', () => {
    const slot = onlySlot(project(mondaySeries(3), [{ ...IDENTITY, start_time: '12:00', end_time: '13:00' }]));
    expect(slot.selected).toBe(false);
  });

  it('does not match a stored slot in another center', () => {
    const slot = onlySlot(project(mondaySeries(3), [{ ...IDENTITY, center_id: 9 }]));
    expect(slot.selected).toBe(false);
  });
});

describe('planSlotBookings', () => {
  it('books every free date of a fully available slot', () => {
    const days = project(mondaySeries(4), [IDENTITY]);
    const [plan] = planSlotBookings(days, [IDENTITY]);

    expect(plan.slot).not.toBeNull();
    expect(plan.book.map((b) => b.date)).toEqual([
      '2026-03-02', '2026-03-09', '2026-03-16', '2026-03-23',
    ]);
    expect(plan.book.map((b) => b.calendar_event_id)).toEqual([100, 101, 102, 103]);
    expect(plan.skip).toEqual([]);
  });

  it('skips a date the Member already holds, and reports why', () => {
    const days = project(mondaySeries(4, (i) => (i === 1 ? { member_booked: 1 } : {})), [IDENTITY]);
    const [plan] = planSlotBookings(days, [IDENTITY]);

    expect(plan.book.map((b) => b.date)).toEqual(['2026-03-02', '2026-03-16', '2026-03-23']);
    expect(plan.skip).toEqual([
      { date: '2026-03-09', calendar_event_id: 101, reason: 'already_booked' },
    ]);
  });

  it('skips a full date, a cancelled one and a week with no occurrence', () => {
    const series = mondaySeries(4, (i) => {
      if (i === 0) return { booked_count: 2 }; // effective_capacity is 2
      if (i === 1) return { status: 'cancelled' };
      return {};
    }).filter((_, i) => i !== 2); // 2026-03-16 has no row at all

    const days = project(series, [IDENTITY]);
    const [plan] = planSlotBookings(days, [IDENTITY]);

    expect(plan.book.map((b) => b.date)).toEqual(['2026-03-23']);
    expect(plan.skip).toEqual([
      { date: '2026-03-02', calendar_event_id: 100, reason: 'full' },
      { date: '2026-03-09', calendar_event_id: 101, reason: 'not_scheduled' },
      { date: '2026-03-16', calendar_event_id: null, reason: 'no_occurrence' },
    ]);
  });

  it('books nothing for a selection the grid no longer offers (§5)', () => {
    // The Member lost the Professional Service, so the projection is empty —
    // existing bookings are untouched and no new ones are created.
    const [plan] = planSlotBookings(project([]), [IDENTITY]);

    expect(plan.slot).toBeNull();
    expect(plan.book).toEqual([]);
    expect(plan.skip).toEqual([]);
    expect(plan.selection).toEqual(IDENTITY);
  });

  it('plans each selection independently', () => {
    const wednesday: SlotIdentity = { ...IDENTITY, weekday: 3, start_time: '12:00', end_time: '13:00' };
    const wednesdayOccurrences = Array.from({ length: 2 }, (_, i) => {
      const start = DateTime.fromISO('2026-03-04T12:00:00', { zone: TZ }).plus({ weeks: i }).toUTC();
      return occurrence({
        calendar_event_id: 200 + i,
        starts_at: start.toFormat('yyyy-MM-dd HH:mm:ss'),
        ends_at: start.plus({ hours: 1 }).toFormat('yyyy-MM-dd HH:mm:ss'),
      });
    });

    const days = project([...mondaySeries(4), ...wednesdayOccurrences], [IDENTITY, wednesday]);
    const plans = planSlotBookings(days, [IDENTITY, wednesday]);

    expect(plans).toHaveLength(2);
    expect(plans[0].book).toHaveLength(4);
    // Two occurrences exist, but the window expects four Wednesdays.
    expect(plans[1].book.map((b) => b.date)).toEqual(['2026-03-04', '2026-03-11']);
    expect(plans[1].skip.map((s) => s.reason)).toEqual(['no_occurrence', 'no_occurrence']);
  });

  it('returns an empty plan list when nothing is selected', () => {
    expect(planSlotBookings(project(mondaySeries(2)), [])).toEqual([]);
  });
});
