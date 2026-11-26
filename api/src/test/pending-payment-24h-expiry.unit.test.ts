// #3307 stages 3 and 7 — the pure halves of the 24-hour Pending Payment expiry:
// the event's display status and the status set the purchase snapshot CHECKs
// accept. Since stage 7 `expired_24h` is a Billing Event display status only:
// no purchase status, no cart line status, no snapshot CHECK value (migration 489).
import { describe, expect, it } from 'vitest';
import { BILLING_EVENT_STATUSES, displayBillingEventStatus } from '../domain/billingEventStatus';
import { CART_ITEM_STATUS } from '../domain/purchaseStatus';
import * as purchaseDomain from '../domain/memberProductPurchase';
import { MEMBER_PRODUCT_STATUSES } from '../domain/memberProductPurchase';
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

  it('expired_24h is not a purchase or cart line status', () => {
    expect((MEMBER_PRODUCT_STATUSES as readonly string[]).includes('expired_24h')).toBe(false);
    expect('EXPIRED_PURCHASE_STATUS' in purchaseDomain).toBe(false);
    expect(CART_ITEM_STATUS.line('expired_24h')).toBeNull();
  });

  it('the snapshot CHECKs accept every purchase status and not expired_24h', () => {
    const statuses: string[] = require('../infra/migrations/489_purchase_expiry_cancels_products.js').PURCHASE_STATUSES;
    expect(statuses).not.toContain('expired_24h');
    expect([...MEMBER_PRODUCT_STATUSES].every((s) => statuses.includes(s))).toBe(true);
  });

  it('the window is 24 hours', () => {
    expect(PENDING_EXPIRY_HOURS).toBe(24);
  });
});
