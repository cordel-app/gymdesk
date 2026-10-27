import { describe, expect, it } from 'vitest';
import {
  effectiveServiceCapacity, serviceOccupancyStatus, parseServiceCapacitiesInput,
} from '../domain/serviceCapacity';

describe('effectiveServiceCapacity', () => {
  it('prefers the occurrence override, then the Activity Type default, then the event capacity', () => {
    expect(effectiveServiceCapacity({ override: 3, activityDefault: 2, eventCapacity: 10 })).toBe(3);
    expect(effectiveServiceCapacity({ override: null, activityDefault: 2, eventCapacity: 10 })).toBe(2);
    expect(effectiveServiceCapacity({ override: null, activityDefault: null, eventCapacity: 10 })).toBe(10);
  });
});

describe('serviceOccupancyStatus', () => {
  it.each([
    [0, 2, 'available'], [1, 2, 'incomplete'], [2, 2, 'full'], [1, 1, 'full'], [3, 2, 'full'],
  ])('%i of %i is %s', (occupied, capacity, status) => {
    expect(serviceOccupancyStatus(occupied, capacity)).toBe(status);
  });
});

describe('parseServiceCapacitiesInput', () => {
  it('accepts positive integers and null, refuses everything else', () => {
    const ok = parseServiceCapacitiesInput({ 5: 2, 6: null, 7: '3' });
    expect(ok.ok && [...ok.capacities.entries()]).toEqual([[5, 2], [6, null], [7, 3]]);
    for (const bad of [{ 5: 0 }, { 5: -1 }, { 5: 1.5 }, { 5: 'x' }, { a: 2 }, [1], null, 'x']) {
      expect(parseServiceCapacitiesInput(bad).ok).toBe(false);
    }
  });
});
