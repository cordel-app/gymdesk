import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { dayCardLabel } from '../../../apps/member/src/lib/trainingWeek';

// #3331 — My Nutrition's first summary card follows the selected date within
// the current week. CI runs `npm test` in api/ only, hence this file.
const today = '2026-11-25'; // a Wednesday

describe('My Nutrition day card (#3331)', () => {
  it('reads Today for today', () => {
    expect(dayCardLabel(today, today)).toBe('today');
  });

  it('reads the weekday for another day of the current week', () => {
    expect(dayCardLabel('2026-11-23', today)).toBe('weekday'); // Monday
    expect(dayCardLabel('2026-11-24', today)).toBe('weekday');
  });

  it('keeps the date for a day of a previous week', () => {
    expect(dayCardLabel('2026-11-22', today)).toBe('date'); // last Sunday
    expect(dayCardLabel('2026-11-10', today)).toBe('date');
  });

  it('the page takes the selected day figures in the current week, and never resets a picked day', () => {
    const page = readFileSync(join(__dirname, '../../../apps/member/src/app/[locale]/nutrition/page.tsx'), 'utf8');
    expect(page).toMatch(/dayCardLabel\(selectedDate, today\)/);
    expect(page).toMatch(/dayKind === 'weekday' \? \(progressDate === selectedDate \? progress\.day/);
    expect(page).not.toMatch(/if \(selectedDate === today\) setSelectedDate\(p\.today\)/);
  });
});
