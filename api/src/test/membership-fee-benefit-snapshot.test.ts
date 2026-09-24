// #635 stage 5 — `membershipFeeBenefitsFromSnapshot()` (membership-promotions.ts).
//
// A unit test: the function is pure, and reading a Promotion application's
// frozen benefit is where a snapshot written *before* this stage has to keep
// pricing exactly as it did. Importing the router module creates the mysql2
// pool, but mysql2 connects lazily and nothing here issues a query, so no
// database is involved.

import { describe, expect, it } from 'vitest';
import { membershipFeeBenefitsFromSnapshot } from '../api/membership-promotions';

const NEW_SHAPE = {
  name: 'Summer',
  membership_fee_benefits: [{
    quantity: 1, frequency_interval: 1, frequency_unit: 'month',
    enabled: true, action: 'fixed_price', value: 29.99, duration_months: 3,
  }],
};

describe('membershipFeeBenefitsFromSnapshot', () => {
  it('returns nothing for a missing snapshot', () => {
    expect(membershipFeeBenefitsFromSnapshot(null)).toEqual([]);
    expect(membershipFeeBenefitsFromSnapshot(undefined)).toEqual([]);
  });

  it('passes a stage-5 snapshot through unchanged', () => {
    expect(membershipFeeBenefitsFromSnapshot(NEW_SHAPE)).toEqual(NEW_SHAPE.membership_fee_benefits);
  });

  it('reads a legacy Period Benefit on the membership fee', () => {
    const legacy = {
      charge_benefits: [],
      period_benefits: [{
        charge_type_code: 'membership_fee', charge_type_name: 'Membership Fee',
        quantity: 1, frequency_interval: 1, frequency_unit: 'month', enabled: true,
        action: 'percentage_discount', value: 25, duration_months: 6,
      }],
      included_benefits: [],
    };
    expect(membershipFeeBenefitsFromSnapshot(legacy)).toEqual([{
      quantity: 1, frequency_interval: 1, frequency_unit: 'month',
      enabled: true, action: 'percentage_discount', value: 25, duration_months: 6,
    }]);
  });

  // A legacy Charge Benefit applied for as long as the promotion did — i.e.
  // enabled, with no duration — which is exactly how it must read back so the
  // arithmetic is unchanged.
  it('reads a legacy Charge Benefit as an enabled, unbounded benefit', () => {
    const legacy = {
      charge_benefits: [{ charge_type_code: 'membership_fee', charge_type_name: 'Membership Fee', action: 'waive', value: null }],
      period_benefits: [],
    };
    expect(membershipFeeBenefitsFromSnapshot(legacy)).toEqual([{
      quantity: 1, frequency_interval: 1, frequency_unit: 'month',
      enabled: true, action: 'waive', value: null, duration_months: null,
    }]);
  });

  it('ignores legacy benefits on any other charge type', () => {
    const legacy = {
      charge_benefits: [{ charge_type_code: 'locker_rental', action: 'waive', value: null }],
      period_benefits: [{ charge_type_code: 'personal_training', quantity: 4, enabled: true, action: null, value: null, duration_months: null }],
      included_benefits: [{ charge_type_code: 'group_class', quantity: 2 }],
    };
    expect(membershipFeeBenefitsFromSnapshot(legacy)).toEqual([]);
  });

  // The Period Benefit comes first because the billing simulation reads the
  // first entry as the Promotion's own timeline benefit and applies the rest
  // on top — which is the order the two were applied in before stage 5.
  it('orders a legacy pair Period Benefit first, Charge Benefit second', () => {
    const legacy = {
      charge_benefits: [{ charge_type_code: 'membership_fee', action: 'fixed_discount', value: 20 }],
      period_benefits: [{
        charge_type_code: 'membership_fee', quantity: 1, frequency_interval: 1, frequency_unit: 'month',
        enabled: true, action: 'percentage_discount', value: 50, duration_months: null,
      }],
    };
    const result = membershipFeeBenefitsFromSnapshot(legacy);
    expect(result).toHaveLength(2);
    expect(result[0].action).toBe('percentage_discount');
    expect(result[1]).toMatchObject({ action: 'fixed_discount', value: 20, enabled: true, duration_months: null });
  });
});
