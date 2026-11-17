// #2945 — the per-beneficiary fee discount rule (domain/feeMemberDiscounts.ts).
import { describe, expect, it } from 'vitest';
import {
  feeUnitBenefit, feeUnitBenefits, parseFeeMemberDiscounts, parseFeeMemberDiscountsInput,
} from '../domain/feeMemberDiscounts';
import { NO_PERSONAL_FEE_BENEFIT } from '../domain/personalFeeBenefit';

const shared20 = { action: 'percentage_discount' as const, value: 20 };

describe('feeUnitBenefit', () => {
  it('null follows the shared benefit; a number replaces it; 0 is no discount', () => {
    expect(feeUnitBenefit(shared20, null)).toEqual(shared20);
    expect(feeUnitBenefit(shared20, 50)).toEqual({ action: 'percentage_discount', value: 50 });
    expect(feeUnitBenefit(shared20, 0)).toEqual(NO_PERSONAL_FEE_BENEFIT);
    expect(feeUnitBenefit(shared20, 150)).toEqual({ action: 'percentage_discount', value: 100 });
  });
});

describe('feeUnitBenefits', () => {
  it('is null when nothing is own, or when the count does not match the units', () => {
    expect(feeUnitBenefits(shared20, [null, null], 2)).toBeNull();
    expect(feeUnitBenefits(shared20, [50], 2)).toBeNull();
    expect(feeUnitBenefits(shared20, null, 2)).toBeNull();
  });
  it('gives one benefit per unit', () => {
    expect(feeUnitBenefits(shared20, [50, null], 2)).toEqual([{ action: 'percentage_discount', value: 50 }, shared20]);
  });
});

describe('parseFeeMemberDiscounts', () => {
  it('reads the SQL list back', () => {
    expect(parseFeeMemberDiscounts(null)).toBeNull();
    expect(parseFeeMemberDiscounts('')).toEqual([null]);
    expect(parseFeeMemberDiscounts('50.00,,0.00')).toEqual([50, null, 0]);
  });
});

describe('parseFeeMemberDiscountsInput', () => {
  it('absent keeps; values and nulls are read; anything else is an error', () => {
    expect(parseFeeMemberDiscountsInput({})).toEqual({ kind: 'absent' });
    expect(parseFeeMemberDiscountsInput({ member_discounts: [{ member_id: 3, percent: '12.5' }, { member_id: 4, percent: null }] }))
      .toEqual({ kind: 'value', value: [{ memberId: 3, percent: 12.5 }, { memberId: 4, percent: null }] });
    expect(parseFeeMemberDiscountsInput({ member_discounts: 'x' }).kind).toBe('error');
    expect(parseFeeMemberDiscountsInput({ member_discounts: [{ member_id: 0, percent: 1 }] }).kind).toBe('error');
    expect(parseFeeMemberDiscountsInput({ member_discounts: [{ member_id: 1, percent: -1 }] }).kind).toBe('error');
    expect(parseFeeMemberDiscountsInput({ member_discounts: [{ member_id: 1, percent: true }] }).kind).toBe('error');
    expect(parseFeeMemberDiscountsInput({ member_discounts: [{ member_id: 1, percent: 1 }, { member_id: 1, percent: 2 }] }).kind).toBe('error');
  });
});
