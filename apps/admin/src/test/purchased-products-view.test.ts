import { describe, expect, it } from 'vitest';
import {
  billingEventPath,
  filterPurchasesByStatus,
  formatAppliedTax,
  hasBillingEvent,
  paymentStatusKey,
  purchaseDate,
} from '@/app/[locale]/members/purchasedProductsView';

// #1521 — the Products card's pure rules: stored values only, `null` where the
// system never stored one, and the billing event named by the purchase itself.

describe('purchased products view (#1521)', () => {
  it('lists a purchase under when it was bought, else when it was created', () => {
    expect(purchaseDate({ purchased_at: '2026-10-01', created_at: '2026-09-30' })).toBe('2026-10-01');
    expect(purchaseDate({ purchased_at: null, created_at: '2026-09-30' })).toBe('2026-09-30');
    expect(purchaseDate({ purchased_at: null, created_at: null })).toBeNull();
  });

  it('reports the stored tax percentage and never invents one', () => {
    expect(formatAppliedTax(21)).toBe('21%');
    expect(formatAppliedTax(10.5)).toBe('10.5%');
    expect(formatAppliedTax(0)).toBe('0%');
    expect(formatAppliedTax(null)).toBeNull();
    expect(formatAppliedTax(undefined)).toBeNull();
  });

  it('only resolves the payment statuses the table can hold', () => {
    for (const s of ['pending', 'completed', 'failed', 'expired']) expect(paymentStatusKey(s)).toBe(s);
    expect(paymentStatusKey(null)).toBeNull();
    expect(paymentStatusKey('refunded')).toBeNull();
  });

  it('opens the purchase\'s own billing event, and nothing when it has none', () => {
    expect(billingEventPath('en', { billing_event_id: 42 })).toBe('/en/payments/billing-events?id=42');
    expect(billingEventPath('es', { billing_event_id: null })).toBeNull();
    expect(billingEventPath('es', {})).toBeNull();
    expect(hasBillingEvent({ billing_event_id: 0 })).toBe(false);
    expect(hasBillingEvent({ billing_event_id: 7 })).toBe(true);
  });
});

describe('filterPurchasesByStatus (#1654)', () => {
  const rows = [{ status: 'draft' }, { status: 'active' }, { status: 'pending_payment' }, { status: 'cancelled' }];
  it('defaults to draft + active + pending payment (#1657)', () => {
    expect(filterPurchasesByStatus(rows, 'open').map((r) => r.status)).toEqual(['draft', 'active', 'pending_payment']);
  });
  it('shows everything for all and one status when chosen', () => {
    expect(filterPurchasesByStatus(rows, '')).toHaveLength(4);
    expect(filterPurchasesByStatus(rows, 'cancelled')).toEqual([{ status: 'cancelled' }]);
  });
});
