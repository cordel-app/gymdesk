import { describe, expect, it } from 'vitest';
import {
  beneficiaryNameIfOther, otherBeneficiaryNames, productTypeLabelKey, purchaseChannelLabelKey, purchaseEventPath, purchaseIsEmpty,
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
