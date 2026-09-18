import { describe, expect, it } from 'vitest';
import { computeCalendarEventStatus, computeOccupancyStatus } from '../api/me';

describe('computeCalendarEventStatus', () => {
  const now = new Date('2026-09-18T12:00:00Z');

  it('returns cancelled regardless of timing', () => {
    expect(computeCalendarEventStatus('cancelled', '2026-09-18T11:00:00Z', '2026-09-18T13:00:00Z', now)).toBe('cancelled');
  });

  it('returns completed regardless of timing', () => {
    expect(computeCalendarEventStatus('completed', '2026-09-18T11:00:00Z', '2026-09-18T13:00:00Z', now)).toBe('completed');
  });

  it('returns running when now falls within the scheduled window', () => {
    expect(computeCalendarEventStatus('scheduled', '2026-09-18T11:00:00Z', '2026-09-18T13:00:00Z', now)).toBe('running');
  });

  it('returns scheduled when now is before the window', () => {
    expect(computeCalendarEventStatus('scheduled', '2026-09-18T13:00:00Z', '2026-09-18T14:00:00Z', now)).toBe('scheduled');
  });

  it('returns scheduled (not running) once the window has fully ended', () => {
    expect(computeCalendarEventStatus('scheduled', '2026-09-18T09:00:00Z', '2026-09-18T10:00:00Z', now)).toBe('scheduled');
  });

  it('treats the end timestamp as exclusive', () => {
    expect(computeCalendarEventStatus('scheduled', '2026-09-18T11:00:00Z', '2026-09-18T12:00:00Z', now)).toBe('scheduled');
  });
});

describe('computeOccupancyStatus', () => {
  it('returns unavailable when access is locked, regardless of capacity', () => {
    expect(computeOccupancyStatus('scheduled', true, 0, 10)).toBe('unavailable');
  });

  it('returns unavailable when the event itself is not scheduled (cancelled/completed)', () => {
    expect(computeOccupancyStatus('cancelled', false, 0, 10)).toBe('unavailable');
    expect(computeOccupancyStatus('completed', false, 0, 10)).toBe('unavailable');
  });

  it('returns full when booked count reaches capacity', () => {
    expect(computeOccupancyStatus('scheduled', false, 10, 10)).toBe('full');
  });

  it('returns full when booked count exceeds capacity (shared bookings)', () => {
    expect(computeOccupancyStatus('scheduled', false, 12, 10)).toBe('full');
  });

  it('returns few_spots_left at the 20% remaining threshold', () => {
    // capacity 10 -> threshold floor(10*0.2) = 2 remaining
    expect(computeOccupancyStatus('scheduled', false, 8, 10)).toBe('few_spots_left');
  });

  it('returns few_spots_left when only one spot remains even under a tiny capacity', () => {
    // capacity 3 -> floor(3*0.2) = 0, but at least 1 remaining spot must still qualify
    expect(computeOccupancyStatus('scheduled', false, 2, 3)).toBe('few_spots_left');
  });

  it('returns available well above the threshold', () => {
    expect(computeOccupancyStatus('scheduled', false, 2, 10)).toBe('available');
  });
});
