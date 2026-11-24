import { describe, expect, it } from 'vitest';
import { PAID_CART_VISIBLE_MINUTES, paidCartStillVisible, visiblePaidCartSql } from '../domain/paidCartVisibility';

// #3307 stage 2 — the window a paid cart stays in Admin → Member → Products.
describe('paid cart visibility', () => {
  const paidAt = new Date('2026-11-24T10:00:00Z');
  it('is one hour', () => expect(PAID_CART_VISIBLE_MINUTES).toBe(60));
  it('keeps the cart inside the hour and drops it after', () => {
    expect(paidCartStillVisible(paidAt, new Date('2026-11-24T10:59:00Z'), false)).toBe(true);
    expect(paidCartStillVisible(paidAt, new Date('2026-11-24T11:00:00Z'), false)).toBe(false);
  });
  it('drops it at once when a newer cart exists, and never shows an unstamped cart', () => {
    expect(paidCartStillVisible(paidAt, new Date('2026-11-24T10:05:00Z'), true)).toBe(false);
    expect(paidCartStillVisible(null, new Date('2026-11-24T10:05:00Z'), false)).toBe(false);
  });
  it('spells the same window in SQL', () => {
    expect(visiblePaidCartSql('p')).toContain(`INTERVAL ${PAID_CART_VISIBLE_MINUTES} MINUTE`);
    expect(visiblePaidCartSql('p')).toContain('newer.id > p.id');
  });
});
