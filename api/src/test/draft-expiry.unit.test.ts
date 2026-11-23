import { describe, expect, it } from 'vitest';
import { CART_TTL_MINUTES, cartExpiresInSeconds } from '../domain/cartExpiry';

describe('cart expiry (#2477, #3274)', () => {
  it('is null with no clock and clamps an expired cart to 0', () => {
    expect(cartExpiresInSeconds(null)).toBeNull();
    expect(cartExpiresInSeconds(-30)).toBe(0);
    expect(cartExpiresInSeconds('5400')).toBe(5400);
  });

  it('keeps the two hours as the one cart TTL', () => {
    expect(CART_TTL_MINUTES).toBe(120);
  });
});
