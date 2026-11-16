import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { memberEventOccupancy } from '../../../apps/member/src/lib/calendarEventDisplay';

// #2903 — the Members App calendar shows a Professional Service event's own
// places, never the Activity's standard capacity. In the API suite for #1009's
// reason: CI runs `npm test` in `api/` only.

const MEMBER = join(__dirname, '..', '..', '..', 'apps', 'member');
const calendar = readFileSync(join(MEMBER, 'src', 'app', '[locale]', 'calendar', 'page.tsx'), 'utf-8');

describe('#2903 memberEventOccupancy', () => {
  it('an event with no Professional Service keeps the Activity standard capacity', () => {
    expect(memberEventOccupancy({ booked_count: 3, effective_capacity: 10, professional_services: [] }))
      .toEqual([{ name: null, booked: 3, capacity: 10 }]);
    expect(memberEventOccupancy({ booked_count: 0, effective_capacity: 8 }))
      .toEqual([{ name: null, booked: 0, capacity: 8 }]);
  });

  it('a single-service event reads the service capacity and its own bookings, not the event total', () => {
    expect(memberEventOccupancy({
      booked_count: 4, effective_capacity: 10,
      professional_services: [{ name: 'Personal Training', capacity: 1, occupied: 1 }],
    })).toEqual([{ name: null, booked: 1, capacity: 1 }]);
  });

  it('a multi-service event reads each service on its own, named, never summed', () => {
    expect(memberEventOccupancy({
      booked_count: 1, effective_capacity: 10,
      professional_services: [
        { name: 'Duo', capacity: 2, occupied: 1 },
        { name: 'Single', capacity: 1, occupied: 0 },
      ],
    })).toEqual([
      { name: 'Duo', booked: 1, capacity: 2 },
      { name: 'Single', booked: 0, capacity: 1 },
    ]);
  });

  it('the calendar event box no longer prints the Activity capacity directly', () => {
    expect(calendar).toContain('memberEventOccupancy(s)');
    expect(calendar).not.toMatch(/occupancy_count', \{ booked: s\.booked_count, capacity: s\.effective_capacity/);
  });
});
