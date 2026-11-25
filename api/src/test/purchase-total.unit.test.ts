// #3355 stage 2 — a purchase's Total Amount (`domain/purchaseTotal.ts`).
import { describe, expect, it } from 'vitest';
import { purchaseTotalAmount } from '../domain/purchaseTotal';

describe('purchaseTotalAmount', () => {
  it('is null with no priced event', () => {
    expect(purchaseTotalAmount([])).toBeNull();
    expect(purchaseTotalAmount([{ id: 1, amount: null, cancelled: false }])).toBeNull();
  });

  it('sums the events that are not cancelled, to the cent', () => {
    expect(purchaseTotalAmount([
      { id: 1, amount: '10.10', cancelled: false },
      { id: 2, amount: 0.2, cancelled: false },
      { id: 3, amount: '99.00', cancelled: true },
    ])).toBe('10.30');
  });

  it('reads the latest event when every event is cancelled', () => {
    expect(purchaseTotalAmount([
      { id: 4, amount: '30.00', cancelled: true },
      { id: 7, amount: '45.00', cancelled: true },
    ])).toBe('45.00');
  });
});
