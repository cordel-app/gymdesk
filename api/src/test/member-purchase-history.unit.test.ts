// #3443 — the pure halves of the Members App's Purchases tab: the API's
// member-facing shape and query rules (`api/me-purchase-history.ts`) and the
// Members App's request, list and status-key rules
// (`apps/member/src/lib/memberPurchaseHistory.ts`, here because CI runs `npm test` in `api/` only).
import { describe, expect, it } from 'vitest';
import { parsePurchaseHistoryQuery, toMemberPurchaseView } from '../api/me-purchase-history';
import type { MemberPurchase } from '../api/member-purchases';
import {
  appendPurchasePage,
  beneficiaryName,
  hasMorePurchases,
  purchaseEventStatusKey,
  purchaseHistoryPath,
  purchasePaymentStatusKey,
  purchaseStatusKey,
  purchaseTotal,
} from '../../../apps/member/src/lib/memberPurchaseHistory';
import { membershipTabs } from '../../../apps/member/src/lib/membershipPages';

const purchase = (id: number): any => ({
  id, name: `P${id}`, status: 'completed', created_at: '2026-11-01T10:00:00.000Z', total_amount: '20.00',
  owner: { id: 1, name: 'Owner' }, plans: [], products: [], billing_events: [],
});

describe('parsePurchaseHistoryQuery', () => {
  it('defaults and validates limit/offset', () => {
    expect(parsePurchaseHistoryQuery({})).toEqual({ ok: true, limit: 10, offset: 0 });
    expect(parsePurchaseHistoryQuery({ limit: '5', offset: '10' })).toEqual({ ok: true, limit: 5, offset: 10 });
    expect(parsePurchaseHistoryQuery({ limit: '0' }).ok).toBe(false);
    expect(parsePurchaseHistoryQuery({ limit: '51' }).ok).toBe(false);
    expect(parsePurchaseHistoryQuery({ offset: '-1' }).ok).toBe(false);
    expect(parsePurchaseHistoryQuery({ limit: '2.5' }).ok).toBe(false);
  });
});

describe('toMemberPurchaseView', () => {
  it('drops the staff-only facts and keeps the three statuses apart', () => {
    const staff: MemberPurchase = {
      ...purchase(7), created_by: 'Desk', modified_at: null, modified_by: 'Desk', channel: 'admin_app',
      products: [{ kind: 'oneoff', line_id: 3, product_id: 4, name: 'Towel', product_type: 'fee',
        billing_frequency: 'once', quantity: 2, status: 'active', beneficiary: null }],
      billing_events: [{ id: 9, name: 'E', event_type: 'product_purchase', amount: '20.00', status: 'paid',
        created_at: '2026-11-01T10:00:00.000Z', attempt_id: 11, payment_method_name: 'Visa',
        payment_method_code: 'visa', method: 'provider', payment_status: 'completed', paid_at: null, attempt_count: 2 }],
    };
    const view = toMemberPurchaseView(staff) as any;
    for (const key of ['created_by', 'modified_by', 'modified_at', 'channel']) expect(view).not.toHaveProperty(key);
    expect(view.products[0]).not.toHaveProperty('line_id');
    expect(view.billing_events[0]).not.toHaveProperty('attempt_id');
    expect(view.status).toBe('completed');
    expect(view.billing_events[0].status).toBe('paid');
    expect(view.billing_events[0].payment_status).toBe('completed');
  });
});

describe('memberPurchaseHistory', () => {
  it('builds the page request', () => {
    expect(purchaseHistoryPath(0)).toBe('/me/purchase-history?limit=10&offset=0');
    expect(purchaseHistoryPath(20, 5)).toBe('/me/purchase-history?limit=5&offset=20');
  });

  it('never lists a purchase twice when a page overlaps', () => {
    const joined = appendPurchasePage([purchase(3), purchase(2)], [purchase(2), purchase(1)]);
    expect(joined.map((p) => p.id)).toEqual([3, 2, 1]);
    expect(hasMorePurchases(3, 4)).toBe(true);
    expect(hasMorePurchases(4, 4)).toBe(false);
  });

  it('answers a key only for a status it has wording for', () => {
    expect(purchaseStatusKey('pending_payment')).toBe('purchases.status.pending_payment');
    expect(purchaseStatusKey('mystery')).toBeNull();
    expect(purchaseEventStatusKey('refunded')).toBe('purchases.event_status.refunded');
    expect(purchaseEventStatusKey(null)).toBeNull();
    expect(purchasePaymentStatusKey('canceled')).toBe('purchases.payment_status.canceled');
    expect(purchasePaymentStatusKey('paid')).toBeNull();
  });

  it('reads the persisted total, null when there is none', () => {
    expect(purchaseTotal(purchase(1))).toBe(20);
    expect(purchaseTotal({ ...purchase(1), total_amount: null })).toBeNull();
  });

  it('names a beneficiary only when it is not the buyer', () => {
    expect(beneficiaryName({ id: 1, name: 'Owner' }, 1)).toBeNull();
    expect(beneficiaryName({ id: 2, name: 'Child' }, 1)).toBe('Child');
    expect(beneficiaryName(null, 1)).toBeNull();
  });

  it('shows Purchases beside Payments, for whoever may view Payments', () => {
    expect(membershipTabs(true)).toEqual(['products', 'services', 'payments', 'purchases']);
    expect(membershipTabs(false)).toEqual(['products', 'services']);
  });
});

describe('locale keys', () => {
  it('every status the lib can answer has wording in en/es/ca', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    for (const loc of ['en', 'es', 'ca']) {
      const d = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../../apps/member/locales/base/${loc}.json`), 'utf8'));
      expect(d.membership.tab_purchases).toBeTruthy();
      for (const s of ['in_cart', 'pending_payment', 'completed', 'cancelled']) expect(d.purchases.status[s]).toBeTruthy();
      for (const s of ['paid', 'failed', 'pending', 'scheduled', 'waived', 'cancelled', 'expired_24h', 'refunded', 'partially_refunded']) {
        expect(d.purchases.event_status[s]).toBeTruthy();
      }
      for (const s of ['completed', 'pending', 'failed', 'expired', 'canceled', 'refunded', 'partially_refunded']) {
        expect(d.purchases.payment_status[s]).toBeTruthy();
      }
    }
  });
});
