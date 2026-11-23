// #3243 — which writes re-read the Member card's Products badge.
import { describe, expect, it } from 'vitest';
import { affectsMemberProducts, isMutationMethod } from '../lib/apiMutations';

describe('apiMutations', () => {
  it('treats only writes as mutations', () => {
    expect(isMutationMethod('GET')).toBe(false);
    expect(isMutationMethod(undefined)).toBe(false);
    expect(isMutationMethod('post')).toBe(true);
    expect(isMutationMethod('DELETE')).toBe(true);
  });

  it('matches the writes that can change the Products badge, and nothing else', () => {
    expect(affectsMemberProducts('/user-memberships/12/activate')).toBe(true);
    expect(affectsMemberProducts('/product-sets/4/save-and-pay')).toBe(true);
    expect(affectsMemberProducts('/members/7/product-purchases')).toBe(true);
    expect(affectsMemberProducts('/membership-plans/3/assign')).toBe(true);
    expect(affectsMemberProducts('/payments/billing-events/9/cancel')).toBe(true);
    expect(affectsMemberProducts('/members/7')).toBe(false);
    expect(affectsMemberProducts('/member-personal-goals/2')).toBe(false);
    expect(affectsMemberProducts('/membership-plans/3/pricing')).toBe(false);
  });
});
