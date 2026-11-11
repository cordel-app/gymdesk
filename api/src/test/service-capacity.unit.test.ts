import { describe, expect, it } from 'vitest';
import {
  effectiveServiceCapacity, serviceOccupancyStatus,
} from '../domain/serviceCapacity';

describe('effectiveServiceCapacity (#2499)', () => {
  it("is the service's own maximum, capped by the event capacity, else the event capacity", () => {
    expect(effectiveServiceCapacity({ serviceMax: 2, eventCapacity: 10 })).toBe(2);
    expect(effectiveServiceCapacity({ serviceMax: 12, eventCapacity: 10 })).toBe(10);
    expect(effectiveServiceCapacity({ serviceMax: null, eventCapacity: 10 })).toBe(10);
  });
});

describe('serviceOccupancyStatus', () => {
  it.each([
    [0, 2, 'available'], [1, 2, 'incomplete'], [2, 2, 'full'], [1, 1, 'full'], [3, 2, 'full'],
  ])('%i of %i is %s', (occupied, capacity, status) => {
    expect(serviceOccupancyStatus(occupied, capacity)).toBe(status);
  });
});
