import { describe, it, expect } from 'vitest';
import { availableGrants, reservationBalance } from '../domain/serviceReservation';
import { chooseSpendGrant } from '../domain/serviceConsumption';

const grant = (reference_id: number, sessions: number) => ({
  professional_service_id: 7, professional_service_name: 'PT', kind: 'plan_session' as const,
  reference_id, product_id: 1, product_name: 'P', sessions,
});

describe('professional service reservations (#2605)', () => {
  it('reserved units reduce what is available, not the remaining balance', () => {
    const rows = [grant(1, 5)];
    const avail = availableGrants(rows, [{ source_kind: 'plan_session', source_reference_id: 1, reserved: 5 }]);
    expect(rows[0].sessions).toBe(5);
    expect(avail[0].sessions).toBe(0);
    expect(chooseSpendGrant(avail, [7])).toBeNull();
  });
  it('a new booking falls to the next grant with room', () => {
    const avail = availableGrants([grant(1, 1), grant(2, 2)], [{ source_kind: 'plan_session', source_reference_id: 1, reserved: 1 }]);
    expect(chooseSpendGrant(avail, [7])?.reference_id).toBe(2);
  });
  it('formats total = available + booked', () => {
    expect(reservationBalance(5, 5)).toEqual({ total: 5, booked: 5, available: 0 });
    expect(reservationBalance(2, 9)).toEqual({ total: 2, booked: 2, available: 0 });
  });
});
