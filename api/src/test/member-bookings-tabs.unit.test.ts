import { describe, expect, it } from 'vitest';
import { BOOKINGS_TABS, bookingsTabAfter } from '../../../apps/member/src/lib/bookingsTabs';

// #1893 — My Bookings is Upcoming | Past, Upcoming first.
describe('My Bookings tabs', () => {
  it('lists Upcoming before Past', () => {
    expect([...BOOKINGS_TABS]).toEqual(['upcoming', 'past']);
  });
  it('moves with the arrow keys and wraps at both ends', () => {
    expect(bookingsTabAfter('upcoming', 1)).toBe('past');
    expect(bookingsTabAfter('past', 1)).toBe('upcoming');
    expect(bookingsTabAfter('upcoming', -1)).toBe('past');
  });
});
