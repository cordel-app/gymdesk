import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// The Members App review's minor details (#1436 follow-up). Source-level gates,
// in the API suite for #1009's reason: CI runs `npm test` in `api/` only.

const root = join(__dirname, '..', '..', '..', 'apps', 'member');
const read = (p: string) => readFileSync(join(root, p), 'utf-8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('My Bookings dates', () => {
  const src = read('src/app/[locale]/schedule/page.tsx');

  it('formats every instant in the gym zone and format, never by slicing the ISO string', () => {
    expect(src).not.toMatch(/\.slice\(0,\s*10\)/);
    expect(src).not.toMatch(/\.slice\(11,\s*16\)/);
    expect(src).toContain('formatGymDate');
    expect(src).toContain('formatGymTime');
    expect(src).toContain('useGymFormatSettings()');
  });
});

describe('Cancelling a booking asks first', () => {
  for (const [name, file] of [
    ['My Bookings', 'src/app/[locale]/schedule/page.tsx'],
    ['the Calendar sheet', 'src/app/[locale]/calendar/page.tsx'],
    ['the Home card', 'src/app/[locale]/page.tsx'],
  ] as const) {
    it(`${name} raises the confirmation instead of calling the API from the button`, () => {
      const src = read(file);
      expect(src).toContain('CancelBookingConfirmDialog');
      expect(src).not.toMatch(/onClick=\{[^}]*\bcancelSession\(/);
      expect(src).not.toMatch(/onClick=\{\(e\) => \{ e\.stopPropagation\(\); cancelBooking\(/);
      expect(src).not.toMatch(/onClick=\{cancelBooking\}[^>]*statusError/);
    });
  }

  it('has its words in the three locales', () => {
    for (const l of ['en', 'es', 'ca']) {
      const json = JSON.parse(readFileSync(join(root, 'locales', 'base', `${l}.json`), 'utf-8'));
      for (const key of ['cancel_confirm_title', 'cancel_confirm_body', 'cancel_confirm_yes', 'cancel_confirm_keep']) {
        expect(json.member_schedule[key], `${l}.${key}`).toBeTruthy();
      }
    }
  });
});

describe('Add plan', () => {
  it('is absent when the gym has no plan to offer', () => {
    const src = read('src/app/[locale]/membership/page.tsx');
    expect(src).toContain('const gymOffersPlans = planCatalogue === null || planCatalogue.length > 0;');
    expect(src).toMatch(/!pendingMembership && !catalogueOpen && gymOffersPlans/);
  });
});
