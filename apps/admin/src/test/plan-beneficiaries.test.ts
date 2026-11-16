import { describe, expect, it } from 'vitest';
import {
  beneficiaryDraftChanged,
  beneficiarySelectionIssue,
  canSelectBeneficiary,
  defaultBeneficiaryIds,
  familyOwnerId,
  orderFamilyMembers,
  toggleBeneficiary,
  type FamilyMemberOption,
} from '@/lib/planBeneficiaries';

// #2879: the beneficiary selector of the Assign Plan workflow.
const family: FamilyMemberOption[] = [
  { member_id: 4, name: 'zoe', is_owner: false },
  { member_id: 2, name: 'Bruno', is_owner: false },
  { member_id: 9, name: 'Paula', is_owner: true },
  { member_id: 3, name: 'anna', is_owner: false },
];

describe('#2879 plan beneficiaries', () => {
  it('orders the family owner first, then the rest alphabetically', () => {
    expect(orderFamilyMembers(family).map((m) => m.member_id)).toEqual([9, 3, 2, 4]);
    expect(familyOwnerId(family)).toBe(9);
  });

  it('defaults to the owner, then alphabetically, up to the plan count', () => {
    expect(defaultBeneficiaryIds(family, '1')).toEqual([9]);
    expect(defaultBeneficiaryIds(family, '2')).toEqual([9, 3]);
    expect(defaultBeneficiaryIds(family, 'family')).toEqual([9, 3, 2, 4]);
  });

  it('refuses a toggle past the limit and frees a place on deselect', () => {
    let selected = [9, 3];
    expect(canSelectBeneficiary(selected, 2, '2')).toBe(false);
    expect(toggleBeneficiary(selected, 2, '2')).toEqual([9, 3]);
    selected = toggleBeneficiary(selected, 9, '2');
    expect(selected).toEqual([3]);
    selected = toggleBeneficiary(selected, 2, '2');
    expect(selected).toEqual([3, 2]);
    // The family owner is not among the beneficiaries, and the selection is complete.
    expect(beneficiarySelectionIssue(family, selected, '2')).toBeNull();
  });

  it('needs exactly the plan count, and at least one for a family plan', () => {
    expect(beneficiarySelectionIssue(family, [9], '2')).toEqual({ key: 'exact_count', count: 2 });
    expect(beneficiarySelectionIssue(family, [], 'family')).toEqual({ key: 'none_selected' });
    expect(beneficiarySelectionIssue(family, [4], 'family')).toBeNull();
    expect(canSelectBeneficiary([9, 3, 2], 4, 'family')).toBe(true);
  });

  it('says when the family is smaller than the plan requires', () => {
    const solo = [family[2]];
    expect(defaultBeneficiaryIds(solo, '2')).toEqual([9]);
    expect(beneficiarySelectionIssue(solo, [9], '2')).toEqual({ key: 'not_enough_family_members', count: 2 });
  });
});

// #2879 stage 2: a Draft's editor holds changes until they are saved.
describe('beneficiaryDraftChanged', () => {
  const saved = { memberLimit: '2', ids: [1, 2] };
  it('is unchanged for the same limit and set in another order', () => {
    expect(beneficiaryDraftChanged(saved, { memberLimit: '2', ids: [2, 1] })).toBe(false);
  });
  it('is changed by a new limit or a different set', () => {
    expect(beneficiaryDraftChanged(saved, { memberLimit: '1', ids: [1, 2] })).toBe(true);
    expect(beneficiaryDraftChanged(saved, { memberLimit: '2', ids: [1, 3] })).toBe(true);
    expect(beneficiaryDraftChanged(saved, { memberLimit: '2', ids: [1] })).toBe(true);
  });
  it('judges a lowered limit against the new count', () => {
    expect(beneficiarySelectionIssue(family, [1, 2], '1')).toEqual({ key: 'exact_count', count: 1 });
    expect(beneficiarySelectionIssue(family, [2], '1')).toBeNull();
  });
});
