import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { bookingDetailRows } from '../../../apps/member/src/lib/bookingDetail';

// #2476 — the shared booking detail dialog's rows. The issue's rules: Center,
// Space, Trainer, Booking Status and Attendees are shown; the waiting list only
// when somebody is waiting; and the API's privacy rule (#503) means a count,
// never names.

describe('bookingDetailRows', () => {
  const base = { center_name: 'Downtown', space_name: 'Room 1', trainer_name: 'Ana', my_booking_status: 'booked', booked_count: 4, waitlist_count: 0 };

  it('lists center, space, trainer, status and attendees, with no waiting list when empty', () => {
    expect(bookingDetailRows(base).map((r) => r.icon)).toEqual(['center', 'space', 'trainer', 'status', 'attendees']);
  });

  it('adds the waiting list only when at least one person waits, as a count', () => {
    const rows = bookingDetailRows({ ...base, waitlist_count: 3 });
    const waiting = rows.find((r) => r.icon === 'waitlist')!;
    expect(waiting.values).toEqual({ count: 3 });
    expect(waiting.text).toBeUndefined();
  });

  it('omits blank names and reports a waitlisted member\'s position', () => {
    const rows = bookingDetailRows({ ...base, center_name: '  ', trainer_name: null, my_booking_status: 'waitlisted', my_waitlist_position: 2 });
    expect(rows.map((r) => r.icon)).not.toContain('center');
    expect(rows.map((r) => r.icon)).not.toContain('trainer');
    expect(rows.find((r) => r.icon === 'status')!.values).toEqual({ pos: 2 });
  });
});

describe('the two entry points share one dialog', () => {
  const read = (p: string) => readFileSync(join(__dirname, '../../../apps/member/src', p), 'utf8');
  it('Home and My Bookings both render BookingDetailDialog', () => {
    expect(read('app/[locale]/page.tsx')).toContain('<BookingDetailDialog');
    expect(read('app/[locale]/schedule/page.tsx')).toContain('<BookingDetailDialog');
  });
});
