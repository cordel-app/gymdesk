// #2476 — what the shared booking detail dialog says, decided here and drawn by
// `components/BookingDetailDialog.tsx`. Pure: no React, no `t()`, no dates. The
// two entry points (Home → My Next Bookings, Bookings → My Bookings) feed it the
// row `GET /me/schedule` already returns, so both show the same information.
//
// Privacy (#503): the API reports the waiting list as a **count** and never who
// is on it, so the dialog shows that count and no names.

import type { ActivityMetaIconName } from '@/components/ActivityMetaIcon';

export interface BookingDetailInput {
  center_name?: string | null;
  space_name?: string | null;
  trainer_name?: string | null;
  my_booking_status?: string | null;
  my_waitlist_position?: number | null;
  booked_count?: number | null;
  waitlist_count?: number | null;
}

export interface BookingDetailRow {
  icon: ActivityMetaIconName;
  labelKey: string;
  /** Locale key + values for the row's value, or a literal string. */
  valueKey?: string;
  values?: Record<string, string | number>;
  text?: string;
}

function named(value: string | null | undefined): string | null {
  const v = value?.trim();
  return v ? v : null;
}

export function bookingDetailRows(b: BookingDetailInput): BookingDetailRow[] {
  const rows: BookingDetailRow[] = [];
  const center = named(b.center_name);
  const space = named(b.space_name);
  const trainer = named(b.trainer_name);
  if (center) rows.push({ icon: 'center', labelKey: 'booking_detail.center', text: center });
  if (space) rows.push({ icon: 'space', labelKey: 'booking_detail.space', text: space });
  if (trainer) rows.push({ icon: 'trainer', labelKey: 'booking_detail.trainer', text: trainer });
  if (b.my_booking_status === 'booked') {
    rows.push({ icon: 'status', labelKey: 'booking_detail.status', valueKey: 'member_schedule.status_booked' });
  } else if (b.my_booking_status === 'waitlisted') {
    rows.push({ icon: 'status', labelKey: 'booking_detail.status', valueKey: 'member_schedule.waitlist_pos', values: { pos: b.my_waitlist_position ?? '?' } });
  }
  if (typeof b.booked_count === 'number') {
    rows.push({ icon: 'attendees', labelKey: 'booking_detail.attendees', valueKey: 'booking_detail.attendees_count', values: { count: b.booked_count } });
  }
  // Only when somebody is waiting; never an empty section.
  if (typeof b.waitlist_count === 'number' && b.waitlist_count > 0) {
    rows.push({ icon: 'waitlist', labelKey: 'booking_detail.waiting_list', valueKey: 'member_calendar.waitlist_count', values: { count: b.waitlist_count } });
  }
  return rows;
}
