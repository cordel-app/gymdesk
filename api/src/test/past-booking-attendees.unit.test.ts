// #3180: the Past bookings attendee split names the caller's Family and only counts everybody else.
import { describe, expect, it } from 'vitest';
import { splitPastBookingAttendees } from '../domain/pastBookingAttendees';

const row = (calendar_event_id: number, member_id: number, name: string) => ({ calendar_event_id, member_id, name });

describe('splitPastBookingAttendees', () => {
  it('names the other Family members, counts outsiders and never includes the caller', () => {
    const out = splitPastBookingAttendees(
      [10],
      [row(10, 1, 'Me'), row(10, 2, 'Zoe Kid'), row(10, 3, 'Ann Kid'), row(10, 7, 'Stranger'), row(10, 8, 'Other')],
      1, [1, 2, 3],
    );
    expect(out.get(10)).toEqual({
      family_attendees: [{ member_id: 3, name: 'Ann Kid' }, { member_id: 2, name: 'Zoe Kid' }],
      other_attendees_count: 2,
    });
    expect(JSON.stringify(out.get(10))).not.toContain('Stranger');
  });

  it('reports no Family section for a member alone in their Family, and zero for an event nobody else attended', () => {
    const out = splitPastBookingAttendees([10, 11], [row(10, 1, 'Me'), row(10, 9, 'X')], 1, [1]);
    expect(out.get(10)).toEqual({ family_attendees: null, other_attendees_count: 1 });
    expect(out.get(11)).toEqual({ family_attendees: null, other_attendees_count: 0 });
  });

  it('gives an empty Family list (not null) when the Family exists but nobody else from it attended', () => {
    const out = splitPastBookingAttendees([10], [], 1, [1, 2]);
    expect(out.get(10)).toEqual({ family_attendees: [], other_attendees_count: 0 });
  });

  it('counts an attendee once and ignores rows for events not asked about', () => {
    const out = splitPastBookingAttendees([10], [row(10, 5, 'A'), row(10, 5, 'A'), row(99, 6, 'B')], 1, [1]);
    expect(out.get(10)?.other_attendees_count).toBe(1);
    expect(out.has(99)).toBe(false);
  });
});
