import { describe, it, expect } from 'vitest';
import { serviceChoices, defaultChoice, selectionMissing, bookedService, noAvailableBalance } from '../../../apps/member/src/lib/serviceSelection';

const accepted = [{ id: 1, name: 'PT Duo' }, { id: 2, name: 'PT Individual' }, { id: 3, name: 'Pilates' }];

describe('#2587 inline Professional Service selection', () => {
  it('shows each accepted service with its balance; a zero balance is disabled', () => {
    const c = serviceChoices(accepted, [
      { professional_service_id: 1, remaining: 4 },
      { professional_service_id: 2, remaining: 0 },
    ]);
    expect(c).toEqual([
      { id: 1, name: 'PT Duo', balance: 4, disabled: false },
      { id: 2, name: 'PT Individual', balance: 0, disabled: true },
      { id: 3, name: 'Pilates', balance: 0, disabled: true },
    ]);
  });

  it('offers nothing for an event that names no service', () => {
    expect(serviceChoices([], [])).toEqual([]);
    expect(selectionMissing([], null)).toBe(false);
  });

  it('preselects only when exactly one service is selectable', () => {
    const one = serviceChoices(accepted, [{ professional_service_id: 1, remaining: 2 }]);
    expect(defaultChoice(one)).toBe(1);
    const two = serviceChoices(accepted, [{ professional_service_id: 1, remaining: 2 }, { professional_service_id: 2, remaining: 1 }]);
    expect(defaultChoice(two)).toBeNull();
  });

  it('Book needs a selection while one is possible, and a disabled one never counts', () => {
    const two = serviceChoices(accepted, [{ professional_service_id: 1, remaining: 2 }, { professional_service_id: 2, remaining: 1 }]);
    expect(selectionMissing(two, null)).toBe(true);
    expect(selectionMissing(two, 3)).toBe(true);
    expect(selectionMissing(two, 2)).toBe(false);
  });

  it('with no selectable service the server explains, not the selector', () => {
    const none = serviceChoices(accepted, []);
    expect(selectionMissing(none, null)).toBe(false);
  });

  it('an unreadable wallet leaves every service selectable for the server to judge', () => {
    const c = serviceChoices(accepted, null);
    expect(c.every((x) => !x.disabled && x.balance === null)).toBe(true);
  });

  it('after booking only the service used is found', () => {
    expect(bookedService(accepted, 2)).toEqual({ id: 2, name: 'PT Individual' });
    expect(bookedService(accepted, null)).toBeNull();
  });

  // #2605 stage 3: what may still be booked is `available` (remaining minus the
  // units future bookings hold), and a sheet with nothing left says so itself.
  it('offers the available balance, not the remaining one, and falls back for an older reader', () => {
    const c = serviceChoices(accepted, [
      { professional_service_id: 1, remaining: 4, available: 0, booked: 4 },
      { professional_service_id: 2, remaining: 3 },
    ]);
    expect(c[0]).toEqual({ id: 1, name: 'PT Duo', balance: 0, disabled: true });
    expect(c[1]).toEqual({ id: 2, name: 'PT Individual', balance: 3, disabled: false });
  });

  it('says every unit is booked only when the balances are known and none is left', () => {
    expect(noAvailableBalance(serviceChoices(accepted, [{ professional_service_id: 1, remaining: 4, available: 0, booked: 4 }]))).toBe(true);
    expect(noAvailableBalance(serviceChoices(accepted, [{ professional_service_id: 1, remaining: 4, available: 1, booked: 3 }]))).toBe(false);
    expect(noAvailableBalance(serviceChoices(accepted, null))).toBe(false);
    expect(noAvailableBalance([])).toBe(false);
  });
});
