// #2657 stage 3 — an Individual Product of an Assigned Plan is one line per member, so a
// draft row's identity and the item it saves carry the member: the server edits that
// member's line and no other.

import { describe, expect, it } from 'vitest';
import { benefitRowKey, toBenefitItems, type ProductBenefitRow } from '@/lib/benefitEditing';

const row = (over: Partial<ProductBenefitRow>): ProductBenefitRow => ({
  product_id: 7, quantity: 1, product_name: 'Locker', product_type: 'service',
  product_billing_frequency: 'month', product_status: 'active', ...over,
});

describe('a plan line held per member', () => {
  it('is keyed by its Product and its member', () => {
    expect(benefitRowKey(row({ assigned_member_id: 3 }))).not.toBe(benefitRowKey(row({ assigned_member_id: 4 })));
    expect(benefitRowKey(row({}))).toBe(benefitRowKey(row({ assigned_member_id: null })));
  });

  it('sends its member back, and a row with none sends no member', () => {
    const [mine, shared] = toBenefitItems([
      row({ assigned_member_id: 3, direct_discount_percent: 20 }),
      row({ product_id: 8 }),
    ]);
    expect(mine).toMatchObject({ product_id: 7, assigned_member_id: 3, direct_discount_percent: 20 });
    expect(shared).not.toHaveProperty('assigned_member_id');
  });
});
