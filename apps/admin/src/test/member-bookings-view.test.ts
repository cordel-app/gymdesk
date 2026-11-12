// #2720 — the Bookings tab's labels: attendance over a booked place, else the booking status.
import { describe, expect, it } from 'vitest';
import { bookingLocation, bookingStatusKey, eventCancelled } from '../app/[locale]/members/bookingsTabView';

describe('bookingsTabView (#2720)', () => {
  it('reads a recorded attendance on a booked place, else the booking status', () => {
    expect(bookingStatusKey({ status: 'booked', attendance_status: 'present' })).toBe('calendar.attendance_present');
    expect(bookingStatusKey({ status: 'booked', attendance_status: 'absent' })).toBe('calendar.attendance_absent');
    expect(bookingStatusKey({ status: 'booked', attendance_status: 'pending' })).toBe('members.booking_status_booked');
    expect(bookingStatusKey({ status: 'waitlisted', attendance_status: 'pending' })).toBe('members.booking_status_waitlisted');
    expect(bookingStatusKey({ status: 'cancelled', attendance_status: 'absent' })).toBe('members.booking_status_cancelled');
    expect(bookingStatusKey({ status: 'odd', attendance_status: null })).toBe('members.booking_status_unknown');
  });

  it('joins the center and space it has, and flags a cancelled event', () => {
    expect(bookingLocation({ center_name: 'Downtown', space_name: 'Room 1' })).toBe('Downtown · Room 1');
    expect(bookingLocation({ center_name: null, space_name: ' Room 1 ' })).toBe('Room 1');
    expect(bookingLocation({ center_name: '', space_name: null })).toBeNull();
    expect(eventCancelled({ session_status: 'cancelled' })).toBe(true);
    expect(eventCancelled({ session_status: 'scheduled' })).toBe(false);
  });
});
