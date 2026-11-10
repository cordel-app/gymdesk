import { describe, it, expect } from 'vitest';
import { serviceChoices, defaultChoice, selectionMissing, bookedService } from '../../../apps/member/src/lib/serviceSelection';

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
});
