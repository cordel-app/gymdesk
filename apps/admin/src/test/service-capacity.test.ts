import { describe, expect, it } from 'vitest';
import { serviceCapacityRange, serviceNameWithCapacity, serviceOccupancyLabel } from '../lib/serviceCapacity';

const t = (key: string, v: { min?: number; max?: number }) =>
  key === 'service_capacity_range' ? `min ${v.min} - max ${v.max}` : key === 'service_capacity_max_only' ? `max ${v.max}` : `min ${v.min}`;

describe('service capacity presentation', () => {
  it('writes occupied / total', () => {
    expect(serviceOccupancyLabel({ occupied: 1, capacity: 2 })).toBe('1 / 2');
  });

  it("shows the service's own capacity beside its name (#2499)", () => {
    expect(serviceNameWithCapacity('Training Duo', { min_participants: 2, max_capacity: 2 }, t)).toBe('Training Duo (min 2 - max 2)');
    expect(serviceNameWithCapacity('Group Class', { min_participants: 2, max_capacity: 12 }, t)).toBe('Group Class (min 2 - max 12)');
  });

  it('leaves out what is not configured instead of inventing a default', () => {
    expect(serviceCapacityRange({ max_capacity: 4 })?.key).toBe('service_capacity_max_only');
    expect(serviceNameWithCapacity('Plain', {}, t)).toBe('Plain');
  });
});
