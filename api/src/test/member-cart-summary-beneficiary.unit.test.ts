// #2973 stage 3 — who a Members App cart Summary line is for, decided from the
// server's `contracted_items`. In the API suite because CI runs `npm test` in `api/` only.
import { describe, expect, it } from 'vitest';
import { reviewBeneficiary } from '../../../apps/member/src/lib/memberProducts';

const review = {
  contracted_items: [
    { kind: 'plan' as const, name: 'Duo', members: [{ member_id: 1, name: 'Ana' }, { member_id: 2, name: 'Bo' }] },
    { kind: 'product' as const, name: 'Locker', members: [{ member_id: 2, name: 'Bo' }] },
    { kind: 'product' as const, name: 'Towel', members: [] },
  ],
};

describe('reviewBeneficiary', () => {
  it('names the one member a line is for', () => {
    expect(reviewBeneficiary(review, { type: 'product', name: 'Locker' })).toEqual({ name: 'Bo' });
  });
  it('says Family for several members or none named', () => {
    expect(reviewBeneficiary(review, { type: 'plan', name: 'Duo' })).toEqual({ family: true });
    expect(reviewBeneficiary(review, { type: 'product', name: 'Towel' })).toEqual({ family: true });
  });
  it('says nothing when the review does not list the item', () => {
    expect(reviewBeneficiary(review, { type: 'product', name: 'Mat' })).toBeNull();
    expect(reviewBeneficiary({}, { type: 'plan', name: 'Duo' })).toBeNull();
  });
});
