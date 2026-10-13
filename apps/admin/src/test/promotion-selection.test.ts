import { describe, expect, it } from 'vitest';
import { promotionBenefitDescription, promotionBlock, revalidateSelection } from '@/lib/promotionSelection';

const A = { id: 1, stackable: true };
const B = { id: 2, stackable: true };
const N = { id: 3, stackable: false };
const all = [A, B, N];

describe('promotionBlock (#1539)', () => {
  it('nothing selected blocks nothing', () => {
    expect(all.map((p) => promotionBlock(p, all, []))).toEqual([null, null, null]);
  });
  it('a selected non-stackable promotion blocks every other and stays checked', () => {
    expect(promotionBlock(N, all, [3])).toBeNull();
    expect(promotionBlock(A, all, [3])).toBe('blocked_by_non_stackable');
  });
  it('deselecting it restores the others', () => {
    expect(promotionBlock(A, all, [])).toBeNull();
  });
  it('stackable selection blocks non-stackable only', () => {
    expect(promotionBlock(B, all, [1])).toBeNull();
    expect(promotionBlock(N, all, [1, 2])).toBe('non_stackable_with_selection');
  });
});

describe('revalidateSelection', () => {
  it('drops ids no longer offered and invalid combinations', () => {
    expect(revalidateSelection([1, 9], [A, B])).toEqual([1]);
    expect(revalidateSelection([1, 3], all)).toEqual([1]);
  });
});

describe('promotionBenefitDescription', () => {
  const m = (n: number) => `${n}€`;
  it('builds from configuration', () => {
    expect(promotionBenefitDescription({ action: 'percentage_discount', value: 50, duration_cycles: 3 }, m))
      .toEqual({ key: 'promo_desc_percent_periods', values: { periods: 3, value: 50 } });
    expect(promotionBenefitDescription({ action: 'fixed_discount', value: 20, duration_cycles: null }, m)?.key).toBe('promo_desc_fixed_discount');
    expect(promotionBenefitDescription({ action: 'no_benefit', value: null, duration_cycles: null }, m)).toBeNull();
  });
});
