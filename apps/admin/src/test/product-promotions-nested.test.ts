import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { hasPromotionBlock } from '../app/[locale]/members/purchasedProductsView';

// #2783 — a Product's Promotion is drawn nested under its own row in the
// Products table, never as a standalone block, and no empty block is drawn.
const MEMBERS = join(__dirname, '..', 'app', '[locale]', 'members');
const TABLE = readFileSync(join(MEMBERS, 'MemberPurchasedProducts.tsx'), 'utf8');
const FORM = readFileSync(join(MEMBERS, 'AddProductPurchase.tsx'), 'utf8');
const DATA_TABLE = readFileSync(join(__dirname, '..', 'components', 'DataTable.tsx'), 'utf8');

describe('#2783 hasPromotionBlock', () => {
  it('is false with no product or nothing to offer', () => {
    expect(hasPromotionBlock(null)).toBe(false);
    expect(hasPromotionBlock({ promotions: [], unavailable_promotions: [] })).toBe(false);
    expect(hasPromotionBlock({})).toBe(false);
  });

  it('is true when the product offers a promotion, or one for new members only', () => {
    expect(hasPromotionBlock({ promotions: [{}] })).toBe(true);
    expect(hasPromotionBlock({ promotions: [], unavailable_promotions: [{}] })).toBe(true);
  });
});

describe('#2783 nested layout', () => {
  it('DataTable draws a nested row only when renderNested answers something', () => {
    expect(DATA_TABLE).toContain('renderNested?: (row: T) => React.ReactNode | null;');
    expect(DATA_TABLE).toMatch(/nested != null && \(\s*<tr data-nested-row>/);
  });

  it('the Products table nests each purchase promotion under its row, and none when absent', () => {
    expect(TABLE).toMatch(/renderNested=\{\(item\) => \(item\.promotion \?/);
    expect(TABLE).toContain(') : null)}');
  });

  it('the Add Product form nests its Promotions under the product, gated on having any', () => {
    expect(FORM).toContain('hasPromotionBlock(product) && (');
    expect(FORM).toContain('data-product-promotions');
    expect(FORM).toContain('listNestedBlockStyle');
  });
});
