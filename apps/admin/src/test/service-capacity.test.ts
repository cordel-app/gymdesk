import { describe, expect, it } from 'vitest';
import { capacitiesPayload, parseCapacityInput, serviceOccupancyLabel } from '../lib/serviceCapacity';

describe('service capacity presentation', () => {
  it('writes occupied / total', () => {
    expect(serviceOccupancyLabel({ occupied: 1, capacity: 2 })).toBe('1 / 2');
  });

  it('empty follows the event capacity, a positive integer is a capacity, the rest is refused', () => {
    expect(parseCapacityInput('')).toBeNull();
    expect(parseCapacityInput(' 3 ')).toBe(3);
    for (const bad of ['0', '-1', '1.5', 'x']) expect(parseCapacityInput(bad)).toBeUndefined();
  });

  it('builds the payload for the selected services only and names the first invalid one', () => {
    expect(capacitiesPayload([1, 2], { 1: '2', 2: '', 3: '9' })).toEqual({ capacities: { 1: 2, 2: null } });
    expect(capacitiesPayload([1, 2], { 1: '2', 2: '0' })).toEqual({ error: 2 });
  });
});
