import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { dayCardLabel, monthCardLabel } from '../../../apps/member/src/lib/trainingWeek';

// #3331 — My Nutrition's first summary card follows the selected date within
// the current week. CI runs `npm test` in api/ only, hence this file.
const today = '2026-11-25'; // a Wednesday
const page = readFileSync(join(__dirname, '../../../apps/member/src/app/[locale]/nutrition/page.tsx'), 'utf8');

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
    expect(page).toMatch(/dayCardLabel\(selectedDate, today\)/);
    expect(page).toMatch(/dayKind === 'weekday' \? \(progressDate === selectedDate \? progress\.day/);
    expect(page).not.toMatch(/if \(selectedDate === today\) setSelectedDate\(p\.today\)/);
  });

  it('labels any day but today with its DD/MM date, never a weekday name', () => {
    expect(page).toMatch(/dayKind === 'today' \? t\('nutrition\.progress_day'\) : ddmm\(selectedDate\)/);
    expect(page).not.toMatch(/weekday: 'long' \}\)\)\s*\n\s*: ddmm/);
  });
});

describe('My Nutrition month card (#3331)', () => {
  it('reads This Month with MM/YYYY for today\'s month', () => {
    expect(monthCardLabel(today, today)).toEqual({ current: true, mmyyyy: '11/2026' });
    expect(monthCardLabel('2026-11-01', today)).toEqual({ current: true, mmyyyy: '11/2026' });
  });

  it('reads MM/YYYY for another month, across a year boundary too', () => {
    expect(monthCardLabel('2026-10-31', today)).toEqual({ current: false, mmyyyy: '10/2026' });
    expect(monthCardLabel('2025-12-15', '2026-01-03')).toEqual({ current: false, mmyyyy: '12/2025' });
  });

  it('the page reports the selected month figures under that label', () => {
    expect(page).toMatch(/monthCardLabel\(selectedDate, today\)/);
    expect(page).toMatch(/month\.current \? summary\.month\s*\n?\s*: \(progressDate === selectedDate \? progress\.month/);
    expect(page).toMatch(/label: monthLabel, percent: monthCounts\.percent/);
  });
});

// #3401 — My Training's month card follows the same rule.
const trainingPage = readFileSync(join(__dirname, '../../../apps/member/src/app/[locale]/training/page.tsx'), 'utf8');
describe('My Training month card (#3401)', () => {
  it('labels the card from the selected date and reports that month', () => {
    expect(trainingPage).toMatch(/monthCardLabel\(selectedDate, today\)/);
    expect(trainingPage).toMatch(/t\('training\.progress_this_month', \{ month: month\.mmyyyy \}\) : month\.mmyyyy/);
    expect(trainingPage).toMatch(/month\.current \? summary\.month : progress\.month/);
    expect(trainingPage).toMatch(/label: monthLabel, percent: monthCounts\.percent/);
    expect(trainingPage).not.toMatch(/training\.progress_month'/);
  });
});
