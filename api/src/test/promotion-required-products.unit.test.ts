import { describe, expect, it } from 'vitest';
import { missingMandatoryProducts } from '../domain/promotionRequiredProducts';

const g = (product_id: number, requirement: string, promotion_id = 1) =>
  ({ promotion_id, product_id, product_name: `P${product_id}`, requirement });

describe('missingMandatoryProducts (#2374)', () => {
  it('lists only mandatory products, never optional ones', () => {
    expect(missingMandatoryProducts([g(2, 'mandatory'), g(3, 'optional')], 1, new Set()))
      .toEqual([{ id: 2, name: 'P2' }]);
  });
  it('excludes the product being added and products already held', () => {
    expect(missingMandatoryProducts([g(1, 'mandatory'), g(2, 'mandatory'), g(3, 'mandatory')], 1, new Set([2])))
      .toEqual([{ id: 3, name: 'P3' }]);
  });
  it('lists a product once across promotions and ignores unknown requirements', () => {
    expect(missingMandatoryProducts([g(2, 'mandatory', 1), g(2, 'mandatory', 2), g(4, 'bogus')], 1, new Set()))
      .toEqual([{ id: 2, name: 'P2' }]);
  });
  it('is empty when nothing is mandatory (apply directly, no modal)', () => {
    expect(missingMandatoryProducts([g(2, 'optional')], 1, new Set())).toEqual([]);
  });
});
