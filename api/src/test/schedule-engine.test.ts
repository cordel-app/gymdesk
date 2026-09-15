// Unit tests for domain/scheduleEngine.ts's computeSlotSegments (#482).
// Pure function, no DB/HTTP dependency.

import { describe, expect, it } from 'vitest';
import { computeSlotSegments } from '../domain/scheduleEngine';

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
