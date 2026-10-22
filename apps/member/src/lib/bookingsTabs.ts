// #1893 — My Bookings is two tabs over the two lists the API already splits
// (`/me/schedule` upcoming, `/me/activity-history` past). Pure: no React.

export const BOOKINGS_TABS = ['upcoming', 'past'] as const;
/** #1983: how far ahead the Upcoming tab reads; its label (`upcoming_section`) says the same number. */
export const UPCOMING_WINDOW_DAYS = 7;
export type BookingsTab = (typeof BOOKINGS_TABS)[number];

/** The tab an arrow key moves to, wrapping at either end. */
export function bookingsTabAfter(current: BookingsTab, step: 1 | -1): BookingsTab {
  const i = BOOKINGS_TABS.indexOf(current);
  return BOOKINGS_TABS[(i + step + BOOKINGS_TABS.length) % BOOKINGS_TABS.length];
}
