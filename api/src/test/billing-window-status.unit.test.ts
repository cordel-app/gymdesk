// #3444 — a Product Set's rolling-window target status after a maintenance pass.
import { describe, expect, it } from 'vitest';
import { windowTargetStatus } from '../domain/billingWindowStatus';

const status = (persistedDates: number, plannedDates: number, created = 0) =>
  windowTargetStatus({ target: 2, persistedDates, plannedDates, created });

describe('windowTargetStatus (#3444)', () => {
  it('reads a set holding the target as at target, or replenished when the pass created events', () => {
    expect(status(2, 2)).toBe('at_target');
    expect(status(2, 2, 1)).toBe('replenished');
    // A prorated stub date beside the two cycles still holds the target.
    expect(status(3, 3)).toBe('at_target');
  });

  it('reads fewer events than the target as a legitimate shortfall only when the contract owes fewer', () => {
    expect(status(1, 1)).toBe('shortfall');
    expect(status(0, 0)).toBe('shortfall');
  });

  it('reads a planned date left without an event as incomplete', () => {
    expect(status(1, 2, 1)).toBe('incomplete');
    expect(status(0, 1)).toBe('incomplete');
    expect(status(1, 3)).toBe('incomplete');
  });
});
