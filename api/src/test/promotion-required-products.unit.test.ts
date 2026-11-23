import { describe, expect, it } from 'vitest';
import { missingMandatoryProducts } from '../domain/promotionRequiredProducts';

const g = (product_id: number, requirement: string, promotion_id = 1) =>
  ({ promotion_id, product_id, product_name: `P${product_id}`, requirement });

const ids = (xs: { id: number; name: string }[]) => xs.map(({ id, name }) => ({ id, name }));

describe('missingMandatoryProducts (#2374)', () => {
  it('lists only mandatory products, never optional ones', () => {
    expect(ids(missingMandatoryProducts([g(2, 'mandatory'), g(3, 'optional')], 1, new Set())))
      .toEqual([{ id: 2, name: 'P2' }]);
  });
  it('excludes the product being added and products already held', () => {
    expect(ids(missingMandatoryProducts([g(1, 'mandatory'), g(2, 'mandatory'), g(3, 'mandatory')], 1, new Set([2]))))
      .toEqual([{ id: 3, name: 'P3' }]);
  });
  it('lists a product once across promotions and ignores unknown requirements', () => {
    expect(ids(missingMandatoryProducts([g(2, 'mandatory', 1), g(2, 'mandatory', 2), g(4, 'bogus')], 1, new Set())))
      .toEqual([{ id: 2, name: 'P2' }]);
  });
  it('is empty when nothing is mandatory (apply directly, no modal)', () => {
    expect(missingMandatoryProducts([g(2, 'optional')], 1, new Set())).toEqual([]);
  });
  it('#3236: names the chosen Promotions that require each product, once each, with their images', () => {
    const grant = (promotion_id: number) => ({
      ...g(2, 'mandatory', promotion_id),
      product_description: 'Locker', product_image_url: 'https://x/p.webp', product_image_thumbnail_url: 'https://x/p-t.webp',
      promotion_name: `Promo ${promotion_id}`, promotion_description: null,
      promotion_image_url: `https://x/${promotion_id}.webp`, promotion_image_thumbnail_url: null,
    });
    const [item] = missingMandatoryProducts([grant(7), grant(8), grant(7)], 1, new Set());
    expect(item).toMatchObject({ id: 2, description: 'Locker', image_thumbnail_url: 'https://x/p-t.webp' });
    expect(item.required_by).toEqual([
      { id: 7, name: 'Promo 7', description: null, image_url: 'https://x/7.webp', image_thumbnail_url: null },
      { id: 8, name: 'Promo 8', description: null, image_url: 'https://x/8.webp', image_thumbnail_url: null },
    ]);
  });
});
