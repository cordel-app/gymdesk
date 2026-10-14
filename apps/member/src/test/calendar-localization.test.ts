import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #1622 — the Members App Calendar takes its language from the page's locale
// and its first weekday and clock from the gym's Time & Localization settings.
// FullCalendar is a third-party widget, so the contract is asserted on the
// props the page hands it.
const src = readFileSync(join(__dirname, '../app/[locale]/calendar/page.tsx'), 'utf8');

describe('Members App calendar localization (#1622)', () => {
  it('registers the Spanish and Catalan packs and follows the page locale', () => {
    expect(src).toContain("from '@fullcalendar/core/locales/es'");
    expect(src).toContain("from '@fullcalendar/core/locales/ca'");
    expect(src).toContain('locales={[esLocale, caLocale]}');
    expect(src).toContain('locale={locale}');
  });

  it('uses the gym first day of week and 12h/24h setting for every time label', () => {
    expect(src).toContain('firstDay={gymFormat.first_day_of_week}');
    expect(src).toContain("slotLabelFormat={{ hour: '2-digit', minute: '2-digit', hour12: gymFormat.time_format === '12h' }}");
    expect(src).toContain("eventTimeFormat={{ hour: '2-digit', minute: '2-digit', hour12: gymFormat.time_format === '12h' }}");
  });
});
