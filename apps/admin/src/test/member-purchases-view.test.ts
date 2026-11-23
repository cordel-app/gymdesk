import { describe, expect, it } from 'vitest';
import {
  beneficiaryNameIfOther, otherBeneficiaryNames, productTypeLabelKey, purchaseEventPath, purchaseIsEmpty,
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
});
