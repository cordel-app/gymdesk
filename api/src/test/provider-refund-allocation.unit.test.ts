// #2480 follow-up: which pending provider refunds the provider's refunded total covers.
import { describe, expect, it } from 'vitest';
import { allocateProviderRefunds } from '../domain/billingEventRefund';

const day = 24 * 60;

describe('allocateProviderRefunds', () => {
  it('completes pending refunds the total covers, oldest first, beyond completed ones', () => {
    const r = allocateProviderRefunds(3000, 1000, [
      { id: 2, cents: 1000, ageMinutes: 30 }, { id: 3, cents: 1500, ageMinutes: 30 },
    ]);
    expect(r).toEqual({ completed: [2], failed: [] });
  });

  it('fails an uncovered refund only once it is past the grace period', () => {
    expect(allocateProviderRefunds(0, 0, [{ id: 1, cents: 500, ageMinutes: 60 }])).toEqual({ completed: [], failed: [] });
    expect(allocateProviderRefunds(0, 0, [{ id: 1, cents: 500, ageMinutes: day }])).toEqual({ completed: [], failed: [1] });
  });

  it('settles nothing when the provider does not say how much it refunded', () => {
    expect(allocateProviderRefunds(null, 0, [{ id: 1, cents: 500, ageMinutes: 2 * day }])).toEqual({ completed: [], failed: [] });
  });
});
