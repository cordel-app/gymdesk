import { describe, it, expect } from 'vitest';
import { serviceChoices, bookingAction, buyServiceIds, zeroBalanceReason } from '../../../apps/member/src/lib/serviceSelection';
import { productsPathForServices } from '../../../apps/member/src/lib/serviceRequired';

// #2848 — an event whose Professional Services the member holds no unit of
// offers Buy (to the Add Product catalogue, narrowed) instead of Book.
const accepted = [{ id: 7, name: 'PT Individual' }, { id: 9, name: 'PT Duo' }];

describe('#2848 Book or Buy', () => {
  it('offers Book while any accepted service has a unit available', () => {
    const c = serviceChoices(accepted, [{ professional_service_id: 7, remaining: 3, available: 1, booked: 2 }]);
    expect(bookingAction(c)).toBe('book');
  });

  it('offers Buy when no accepted service has a unit available', () => {
    const c = serviceChoices(accepted, [{ professional_service_id: 7, remaining: 0, available: 0, booked: 0 }]);
    expect(bookingAction(c)).toBe('buy');
    expect(buyServiceIds(c)).toEqual([7, 9]);
    expect(productsPathForServices(buyServiceIds(c))).toBe('/membership/add-product?professional_service_ids=7,9');
  });

  it('keeps Book when the wallet could not be read, or the event names no service', () => {
    expect(bookingAction(serviceChoices(accepted, null))).toBe('book');
    expect(bookingAction(serviceChoices([], []))).toBe('book');
  });

  it('explains a zero balance as "already booked" only when bookings hold the units', () => {
    expect(zeroBalanceReason(serviceChoices(accepted, [{ professional_service_id: 7, remaining: 2, available: 0, booked: 2 }]))).toBe('all_booked');
    expect(zeroBalanceReason(serviceChoices(accepted, [{ professional_service_id: 7, remaining: 0, available: 0, booked: 0 }]))).toBe('none_left');
    expect(zeroBalanceReason(serviceChoices(accepted, []))).toBe('none_left');
  });
});
