import { describe, expect, it } from 'vitest';
import { hasSharedService, leftServiceIncomplete, participantsBody, servicePlacesLabel } from '../lib/servicePlaces';

const svc = (capacity: number, occupied: number, status: 'available' | 'incomplete' | 'full') =>
  ({ id: 1, name: 'Duo', capacity, occupied, remaining: capacity - occupied, status });

describe('service places', () => {
  it('writes occupied / total', () => {
    expect(servicePlacesLabel({ occupied: 1, capacity: 2 })).toBe('1 / 2');
  });

  it('offers a participant only on a service that has more than one place and is not full', () => {
    expect(hasSharedService(undefined)).toBe(false);
    expect(hasSharedService([svc(1, 0, 'available')])).toBe(false);
    expect(hasSharedService([svc(2, 2, 'full')])).toBe(false);
    expect(hasSharedService([svc(1, 0, 'available'), svc(2, 1, 'incomplete')])).toBe(true);
  });

  it('sends no participant field when nobody is selected', () => {
    expect(participantsBody([])).toEqual({});
    expect(participantsBody(new Set([4, 7]))).toEqual({ participant_member_ids: [4, 7] });
  });

  it('warns only when the API says the service is left incomplete', () => {
    expect(leftServiceIncomplete({ service: { status: 'incomplete' } })).toBe(true);
    expect(leftServiceIncomplete({ service: { status: 'full' } })).toBe(false);
    expect(leftServiceIncomplete({ service: null })).toBe(false);
    expect(leftServiceIncomplete(null)).toBe(false);
  });
});
