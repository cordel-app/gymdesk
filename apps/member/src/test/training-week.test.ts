import { describe, it, expect } from 'vitest';
import { addDays, canShowNextWeek, mondayIndex, shiftWeek, shiftWeekWithin, swipeWeekDelta, weekDates, weekdayOf, weekStart } from '../lib/trainingWeek';

describe('trainingWeek (#1370 stage 2)', () => {
  it('builds Monday-first weeks and numbers weekdays 0=Sunday', () => {
    expect(weekDates('2026-10-14')).toEqual(['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18']);
    expect(weekStart('2026-10-18')).toBe('2026-10-12');
    expect(weekdayOf('2026-10-18')).toBe(0);
    expect(mondayIndex('2026-10-18')).toBe(6);
  });
  it('keeps the weekday when moving a week, across month and year edges', () => {
    expect(shiftWeek('2026-10-13', -1)).toBe('2026-10-06');
    expect(shiftWeek('2026-12-30', 1)).toBe('2027-01-06');
    expect(weekdayOf(shiftWeek('2026-10-13', 5))).toBe(weekdayOf('2026-10-13'));
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
  it('only a long, mostly horizontal swipe changes the week', () => {
    expect(swipeWeekDelta(-80, 10)).toBe(1);
    expect(swipeWeekDelta(80, -10)).toBe(-1);
    expect(swipeWeekDelta(-30, 0)).toBe(0);
    expect(swipeWeekDelta(-80, 120)).toBe(0); // a vertical scroll
  });
});

describe('shiftWeekWithin / canShowNextWeek (#1815)', () => {
  const today = '2026-10-14'; // Wednesday
  it('goes back across month and year boundaries', () => {
    expect(shiftWeekWithin('2027-01-02', -1, '2027-01-02')).toBe('2026-12-26');
    expect(shiftWeekWithin('2026-10-14', -3, today)).toBe('2026-09-23');
  });
  it('never moves past the current week', () => {
    expect(shiftWeekWithin(today, 1, today)).toBe(today);
    expect(canShowNextWeek(today, today)).toBe(false);
  });
  it('lands on today, not a future day, when returning to the current week', () => {
    expect(shiftWeekWithin('2026-10-07', 1, today)).toBe('2026-10-14');
    expect(shiftWeekWithin('2026-10-09', 1, today)).toBe('2026-10-14');
    expect(canShowNextWeek('2026-10-07', today)).toBe(true);
  });
});
