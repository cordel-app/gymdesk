import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #979 §6 — the Members App alert for a reactivated class.
//
// The row itself is written by the API (`event_reactivated`, migration 216);
// what these tests guard is that the Alerts page can word it, that it says the
// member's own booking is back, and that it is not the booking alert.

const SRC = join(__dirname, '..');
const notificationsPage = readFileSync(join(SRC, 'app', '[locale]', 'notifications', 'page.tsx'), 'utf-8');

const LOCALES_DIR = join(SRC, '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

const NEW_KEYS = ['type_event_reactivated', 'detail_event_reactivated'] as const;

describe('The Alerts page carries the reactivation line (#979 §6)', () => {
  it('declares which types have a second line rather than falling back', () => {
    // next-intl prints a missing key verbatim, so asking for
    // `detail_<type>` on every type would render
    // `notifications.detail_booking_confirmed` on screen.
    expect(notificationsPage).toContain('DETAIL_TYPES');
    expect(notificationsPage).toMatch(/DETAIL_TYPES = \[\s*'event_reactivated'\s*\]/);
    expect(notificationsPage).toMatch(/DETAIL_TYPES\.includes\(n\.type\)/);
  });

  it('renders it from the locale file, under the class name', () => {
    expect(notificationsPage).toMatch(/t\(`detail_\$\{n\.type\}`/);
  });
});

describe('Locale coverage for the new strings (#979)', () => {
  it('has both keys in every locale', () => {
    for (const code of LOCALE_CODES) {
      const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
      for (const key of NEW_KEYS) {
        const value = messages.notifications?.[key];
        expect(value, `${code}.json is missing notifications.${key}`).toBeTypeOf('string');
        expect((value as string).length).toBeGreaterThan(0);
      }
    }
  });

  it('says the class is back and the booking with it, and never that it is new', () => {
    const en = JSON.parse(readFileSync(join(LOCALES_DIR, 'en.json'), 'utf-8'));
    expect(en.notifications.detail_event_reactivated.toLowerCase()).toContain('restored');
    // §6 — this is not a new booking the member made, and the copy must not
    // read like the `booking_confirmed` alert.
    for (const key of NEW_KEYS) {
      expect(en.notifications[key].toLowerCase()).not.toContain('confirmed');
    }
    expect(en.notifications.type_event_reactivated)
      .not.toBe(en.notifications.type_booking_confirmed);
  });
});
