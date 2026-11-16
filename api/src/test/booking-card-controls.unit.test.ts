// #2904 — My Bookings folds a Professional Service card's booking controls
// until the card is expanded. The rule is the Members App's pure module; the
// page is the only consumer (CI runs `npm test` in `api/` only).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  bookingControlsCollapsible,
  showBookingControls,
} from '../../../apps/member/src/lib/bookingCardControls';

const svc = [{ id: 1 }];

describe('bookingControlsCollapsible', () => {
  it('folds a bookable card that offers a Professional Service', () => {
    expect(bookingControlsCollapsible({ professional_services: svc, my_booking_status: null })).toBe(true);
  });
  it('does not fold a card with no Professional Service', () => {
    expect(bookingControlsCollapsible({ professional_services: [], my_booking_status: null })).toBe(false);
    expect(bookingControlsCollapsible({ professional_services: null })).toBe(false);
  });
  it('does not fold a booked or waitlisted card, whose Cancel must stay reachable', () => {
    expect(bookingControlsCollapsible({ professional_services: svc, my_booking_status: 'booked' })).toBe(false);
    expect(bookingControlsCollapsible({ professional_services: svc, my_booking_status: 'waitlisted' })).toBe(false);
  });
  it('does not fold a locked card', () => {
    expect(bookingControlsCollapsible({ professional_services: svc, access_locked: true })).toBe(false);
  });
});

describe('showBookingControls', () => {
  it('hides folded controls until the card is expanded', () => {
    const s = { professional_services: svc, my_booking_status: null };
    expect(showBookingControls(s, false)).toBe(false);
    expect(showBookingControls(s, true)).toBe(true);
  });
  it('always shows controls that do not fold', () => {
    expect(showBookingControls({ professional_services: [] }, false)).toBe(true);
  });
});

describe('My Bookings page', () => {
  const page = readFileSync(
    resolve(__dirname, '../../../apps/member/src/app/[locale]/schedule/page.tsx'),
    'utf8',
  );
  it('gates the booking controls on the rule and shows the expand chevron', () => {
    expect(page).toContain('showBookingControls(s, isExpanded)');
    expect(page).toContain('{controlsShown && (');
    expect(page).toContain("isExpanded ? '▾' : '▸'");
  });
  it('the toggle only changes the expanded card, never books', () => {
    expect(page).toMatch(/const toggle = \(\) => setExpandedSession\(isExpanded \? null : s\.id\);/);
  });
});
