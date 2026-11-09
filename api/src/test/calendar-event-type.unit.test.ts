import { describe, it, expect } from 'vitest';
import { parseCalendarEventType, parseEventCapacity, parseEventServiceIds } from '../domain/calendarEventType';

describe('calendar event type (#2559)', () => {
  it('accepts the three types and treats absence as none', () => {
    expect(parseCalendarEventType('private')).toEqual({ type: 'private' });
    expect(parseCalendarEventType(null)).toEqual({ type: null });
    expect('error' in parseCalendarEventType('vip')).toBe(true);
  });
  it('capacity is a positive integer or none', () => {
    expect(parseEventCapacity('')).toEqual({ capacity: null });
    expect(parseEventCapacity(8)).toEqual({ capacity: 8 });
    expect('error' in parseEventCapacity(0)).toBe(true);
    expect('error' in parseEventCapacity(2.5)).toBe(true);
  });
  it('service ids are positive integers, de-duplicated', () => {
    expect(parseEventServiceIds([3, '3', 4])).toEqual({ ids: [3, 4] });
    expect('error' in parseEventServiceIds('3')).toBe(true);
    expect('error' in parseEventServiceIds([0])).toBe(true);
  });
});
