// Unit tests for domain/scheduleEngine.ts's computeSlotSegments and rulesOverlap (#482).
// Pure functions, no DB/HTTP dependency.

import { describe, expect, it } from 'vitest';
import { computeSlotSegments, rulesOverlap, type RuleWindowConfig } from '../domain/scheduleEngine';

describe('computeSlotSegments', () => {
  it('slices an evenly-divisible window into duration-sized slots', () => {
    expect(computeSlotSegments('16:00', '20:00', 60)).toEqual([
      { start: '16:00', end: '17:00' },
      { start: '17:00', end: '18:00' },
      { start: '18:00', end: '19:00' },
      { start: '19:00', end: '20:00' },
    ]);
  });

  it('drops a trailing remainder that does not fill a whole slot', () => {
    // 15:00-17:00 (120 min) with a 45-minute duration -> 2 full slots, 30 min dropped
    expect(computeSlotSegments('15:00', '17:00', 45)).toEqual([
      { start: '15:00', end: '15:45' },
      { start: '15:45', end: '16:30' },
    ]);
  });

  it('produces exactly one slot when the window equals the duration', () => {
    expect(computeSlotSegments('19:00', '20:00', 60)).toEqual([
      { start: '19:00', end: '20:00' },
    ]);
  });

  it('produces no slots when duration is longer than the window', () => {
    expect(computeSlotSegments('15:00', '15:30', 60)).toEqual([]);
  });

  it('supports multi-hour windows with a 90-minute duration', () => {
    expect(computeSlotSegments('16:00', '20:00', 90)).toEqual([
      { start: '16:00', end: '17:30' },
      { start: '17:30', end: '19:00' },
    ]);
  });

  it('returns the whole window as a single segment when duration is null (legacy rows)', () => {
    expect(computeSlotSegments('16:00', '20:00', null)).toEqual([
      { start: '16:00', end: '20:00' },
    ]);
  });

  it('returns the whole window as a single segment when duration is not positive', () => {
    expect(computeSlotSegments('16:00', '20:00', 0)).toEqual([
      { start: '16:00', end: '20:00' },
    ]);
    expect(computeSlotSegments('16:00', '20:00', -30)).toEqual([
      { start: '16:00', end: '20:00' },
    ]);
  });

  it('accepts HH:MM:SS input and trims to HH:MM', () => {
    expect(computeSlotSegments('16:00:00', '18:00:00', 60)).toEqual([
      { start: '16:00', end: '17:00' },
      { start: '17:00', end: '18:00' },
    ]);
  });
});

describe('rulesOverlap', () => {
  function weekly(overrides: Partial<RuleWindowConfig> = {}): RuleWindowConfig {
    return {
      type: 'weekly',
      start_date: '2026-01-05', // a Monday
      end_date: '2026-01-11', // the following Sunday
      weekday: null,
      weekdays: [1], // Monday
      ordinal: null,
      start_time: '16:00',
      end_time: '17:00',
      ...overrides,
    };
  }

  it('overlaps when weekday, date range, and time window all intersect', () => {
    const a = weekly({ start_time: '16:00', end_time: '17:00' });
    const b = weekly({ start_time: '16:30', end_time: '17:30' });
    expect(rulesOverlap(a, b)).toBe(true);
  });

  it('does not overlap when time windows are adjacent but not intersecting', () => {
    const a = weekly({ start_time: '16:00', end_time: '17:00' });
    const b = weekly({ start_time: '17:00', end_time: '18:00' });
    expect(rulesOverlap(a, b)).toBe(false);
  });

  it('does not overlap when weekdays differ', () => {
    const a = weekly({ weekdays: [1] }); // Monday
    const b = weekly({ weekdays: [2] }); // Tuesday
    expect(rulesOverlap(a, b)).toBe(false);
  });

  it('overlaps when weekday sets share at least one day', () => {
    const a = weekly({ weekdays: [1, 3] }); // Mon, Wed
    const b = weekly({ weekdays: [3, 5] }); // Wed, Fri
    expect(rulesOverlap(a, b)).toBe(true);
  });

  it('does not overlap when date ranges do not intersect', () => {
    const a = weekly({ start_date: '2026-01-05', end_date: '2026-01-11' });
    const b = weekly({ start_date: '2026-02-02', end_date: '2026-02-08' });
    expect(rulesOverlap(a, b)).toBe(false);
  });

  it('treats a null end_date as open-ended for overlap purposes', () => {
    const a = weekly({ start_date: '2026-01-05', end_date: null });
    const b = weekly({ start_date: '2026-06-01', end_date: '2026-06-07' });
    expect(rulesOverlap(a, b)).toBe(true);
  });

  it('compares a one_off rule by the weekday derived from its start_date', () => {
    const oneOff: RuleWindowConfig = {
      type: 'one_off',
      start_date: '2026-01-05', // Monday
      end_date: null,
      weekday: null,
      weekdays: null,
      ordinal: null,
      start_time: '16:30',
      end_time: '17:30',
    };
    const weeklyMonday = weekly({ start_time: '16:00', end_time: '17:00' });
    expect(rulesOverlap(oneOff, weeklyMonday)).toBe(true);

    const weeklyTuesday = weekly({ weekdays: [2], start_time: '16:00', end_time: '17:00' });
    expect(rulesOverlap(oneOff, weeklyTuesday)).toBe(false);
  });

  it('compares a monthly rule by its configured weekday, ignoring ordinal', () => {
    const monthly: RuleWindowConfig = {
      type: 'monthly',
      start_date: '2026-01-01',
      end_date: '2026-12-31',
      weekday: 1, // Monday
      weekdays: null,
      ordinal: 'first',
      start_time: '16:00',
      end_time: '17:00',
    };
    const weeklyMonday = weekly({ start_time: '16:30', end_time: '17:30' });
    expect(rulesOverlap(monthly, weeklyMonday)).toBe(true);

    const weeklyTuesday = weekly({ weekdays: [2] });
    expect(rulesOverlap(monthly, weeklyTuesday)).toBe(false);
  });
});
