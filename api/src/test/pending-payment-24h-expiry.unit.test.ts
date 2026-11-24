// #3307 stage 3 — the pure halves of the 24-hour Pending Payment expiry: the
// event's display status, the cart's reading of an expired line, and the status
// set the purchase snapshot CHECKs accept (migration 483).
import { describe, expect, it } from 'vitest';
import { BILLING_EVENT_STATUSES, displayBillingEventStatus } from '../domain/billingEventStatus';
import { CART_ITEM_STATUS } from '../domain/purchaseStatus';
import { EXPIRED_PURCHASE_STATUS, MEMBER_PRODUCT_STATUSES } from '../domain/memberProductPurchase';
import { PENDING_EXPIRY_HOURS } from '../domain/productSet';

describe('24h expiry', () => {
  it('a cancelled event the expiry closed reads expired_24h; nothing else changes', () => {
    expect(BILLING_EVENT_STATUSES).toContain('expired_24h');
    expect(displayBillingEventStatus('cancelled', null, true)).toBe('expired_24h');
    expect(displayBillingEventStatus('cancelled', null, false)).toBe('cancelled');
    expect(displayBillingEventStatus('cancelled', null)).toBe('cancelled');
    // A collected payment keeps its own status, expired_at or not.
    expect(displayBillingEventStatus('paid', 'full', true)).toBe('refunded');
    expect(displayBillingEventStatus('pending', null, true)).toBe('pending');
  });

  it('an expired line is a cancelled cart item', () => {
    expect(CART_ITEM_STATUS.line(EXPIRED_PURCHASE_STATUS)).toBe('cancelled');
  });

  it('the snapshot CHECKs accept every purchase status plus expired_24h', () => {
    const statuses: string[] = require('../infra/migrations/483_pending_payment_24h_expiry.js').PURCHASE_STATUSES;
    expect(statuses).toContain(EXPIRED_PURCHASE_STATUS);
    expect([...MEMBER_PRODUCT_STATUSES].every((s) => statuses.includes(s))).toBe(true);
  });

  it('the window is 24 hours', () => {
    expect(PENDING_EXPIRY_HOURS).toBe(24);
  });
});
