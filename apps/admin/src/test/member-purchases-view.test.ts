import { describe, expect, it } from 'vitest';
import {
  beneficiaryNameIfOther, otherBeneficiaryNames, productTypeLabelKey, purchaseChannelLabelKey, purchaseDisplayName, purchaseEventPath, purchaseIsEmpty,
  purchaseTotalValue, purchaseCanCancel, purchaseCancelErrorKey,
} from '@/app/[locale]/members/purchasesTabView';

// #3273 — the Purchases tab's presentation decisions.
const owner = { id: 1, name: 'Owner' };

describe('purchasesTabView (#3273)', () => {
  it('names the beneficiary only where it is not the buyer', () => {
    expect(beneficiaryNameIfOther(owner, owner)).toBeNull();
    expect(beneficiaryNameIfOther(null, owner)).toBeNull();
    expect(beneficiaryNameIfOther({ id: 2, name: 'Child' }, owner)).toBe('Child');
    expect(otherBeneficiaryNames({ beneficiaries: [owner, { id: 2, name: 'Child' }] }, owner)).toEqual(['Child']);
  });

  it('opens the exact Billing Event', () => {
    expect(purchaseEventPath('es', 42)).toBe('/es/payments/billing-events?id=42');
  });

  it('labels only known product types and spots an empty purchase', () => {
    expect(productTypeLabelKey('fee')).toBe('products.type_fee');
    expect(productTypeLabelKey('weird')).toBeNull();
    expect(purchaseIsEmpty({ plans: [], products: [] })).toBe(true);
  });

  it('labels a purchase channel, unknown reading as no key (#3278)', () => {
    expect(purchaseChannelLabelKey('admin_app')).toBe('members.purchases_channel_admin_app');
    expect(purchaseChannelLabelKey('members_app')).toBe('members.purchases_channel_members_app');
    expect(purchaseChannelLabelKey(null)).toBeNull();
    expect(purchaseChannelLabelKey('system')).toBeNull();
  });
});

describe('purchases table (#3355 stage 2)', () => {
  it('names a row by its stored name, else its creation instant', () => {
    expect(purchaseDisplayName({ name: 'Gym - Purchase - 23/11/2026 11:56', created_at: '2026-11-23T10:56:00Z' }))
      .toBe('Gym - Purchase - 23/11/2026 11:56');
    expect(purchaseDisplayName({ name: null, created_at: '2026-11-23T10:56:00Z' })).toBe('2026-11-23T10:56:00Z');
  });

  it('reads the API total, and nothing as no total', () => {
    expect(purchaseTotalValue({ total_amount: '45.50' })).toBe(45.5);
    expect(purchaseTotalValue({ total_amount: null })).toBeNull();
  });

  it('#3355 stage 3 — offers Cancel only on a purchase awaiting payment, and words a refusal by its code', () => {
    expect(purchaseCanCancel({ status: 'pending_payment' })).toBe(true);
    for (const status of ['in_cart', 'completed', 'cancelled']) expect(purchaseCanCancel({ status })).toBe(false);
    expect(purchaseCancelErrorKey('payment_settled')).toBe('members.purchases_cancel_error_settled');
    expect(purchaseCancelErrorKey('payment_unresolved')).toBe('members.purchases_cancel_error_unresolved');
    expect(purchaseCancelErrorKey('not_pending_payment')).toBe('members.purchases_cancel_error_not_pending');
    expect(purchaseCancelErrorKey(undefined)).toBe('members.purchases_cancel_error');
  });
});
