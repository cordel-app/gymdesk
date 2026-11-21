// #3091 — the Members App's beneficiary selection while contracting a plan.
import { describe, expect, it } from 'vitest';
import {
  beneficiaryCountErrorKey, defaultBeneficiaryIds, offersBeneficiaryChoice, toggleBeneficiary,
} from '../lib/memberPlanCatalogue';

const family = [{ member_id: 1, name: 'Me' }, { member_id: 2, name: 'Child' }, { member_id: 3, name: 'Other' }];

describe('beneficiary selection', () => {
  it('seeds the member first, up to the plan\'s count; a family plan covers everyone', () => {
    expect(defaultBeneficiaryIds('1', family)).toEqual([1]);
    expect(defaultBeneficiaryIds('2', family)).toEqual([1, 2]);
    expect(defaultBeneficiaryIds('family', family)).toEqual([1, 2, 3]);
  });
  it('does not lock the member in', () => {
    expect(toggleBeneficiary([1], 1)).toEqual([]);
    expect(toggleBeneficiary([1], 2)).toEqual([1, 2]);
  });
  it('names the count problem, none for a valid selection', () => {
    expect(beneficiaryCountErrorKey('2', [1])).toBe('membership.beneficiaries_count_2');
    expect(beneficiaryCountErrorKey('1', [])).toBe('membership.beneficiaries_required');
    expect(beneficiaryCountErrorKey('1', [2])).toBeNull();
    expect(beneficiaryCountErrorKey('family', [1, 2, 3])).toBeNull();
  });
  it('offers the choice only with a family to choose from', () => {
    expect(offersBeneficiaryChoice([family[0]])).toBe(false);
    expect(offersBeneficiaryChoice(family)).toBe(true);
  });
});
