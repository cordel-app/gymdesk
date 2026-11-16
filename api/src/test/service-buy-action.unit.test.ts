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

// #2848 stage 2 — an event offering several services, one with sessions and
// one without: the zero-balance service stays choosable and choosing it offers
// Buy for that service alone, while the other stays bookable.
describe('#2848 stage 2: one service at zero among several', () => {
  const wallet = [
    { professional_service_id: 9, remaining: 2, available: 2, booked: 0 }, // PT Duo
    { professional_service_id: 7, remaining: 0, available: 0, booked: 0 }, // PT Individual
  ];

  it('offers Buy narrowed to the chosen zero-balance service', () => {
    const c = serviceChoices(accepted, wallet);
    expect(bookingAction(c, 7)).toBe('buy');
    expect(buyServiceIds(c, 7)).toEqual([7]);
    expect(productsPathForServices(buyServiceIds(c, 7))).toBe('/membership/add-product?professional_service_ids=7');
    expect(zeroBalanceReason(c, 7)).toBe('none_left');
  });

  it('keeps Book for the service with a balance, and while nothing is chosen', () => {
    const c = serviceChoices(accepted, wallet);
    expect(bookingAction(c, 9)).toBe('book');
    expect(bookingAction(c, null)).toBe('book');
  });

  it('words the reason from the chosen service only', () => {
    const c = serviceChoices(accepted, [
      { professional_service_id: 9, remaining: 2, available: 0, booked: 2 },
      { professional_service_id: 7, remaining: 0, available: 0, booked: 0 },
      { professional_service_id: 11, remaining: 1, available: 1, booked: 0 },
    ]);
    expect(zeroBalanceReason(c, 7)).toBe('none_left');
    expect(zeroBalanceReason(c, 9)).toBe('all_booked');
  });
});
