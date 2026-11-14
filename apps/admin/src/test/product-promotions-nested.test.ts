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

  it('#2810 — the Products table draws a purchase promotion inside its Product cell, never as a row below it', () => {
    expect(TABLE).not.toContain('renderNested=');
    const productCol = TABLE.slice(TABLE.indexOf("key: 'product',"), TABLE.indexOf("key: 'assigned_to',"));
    expect(productCol).toContain('{item.promotion && (');
    expect(productCol).toContain('data-product-promotion');
  });

  it('#2810 — the Add Product form draws its Promotions inside the Product cell, gated on having any', () => {
    expect(FORM).toContain('hasPromotionBlock(product)');
    expect(FORM).toContain('data-product-promotions');
    // The Product cell carries the selector and, under it, its own Promotions.
    const cell = FORM.slice(FORM.indexOf('    product: ('), FORM.indexOf('    // #2786'));
    expect(cell.indexOf('<select')).toBeGreaterThan(-1);
    expect(cell.indexOf('{productPromotionsCell(f)}')).toBeGreaterThan(cell.indexOf('</select>'));
    // …and nothing below the row repeats them.
    const details = FORM.slice(FORM.indexOf('export function AddProductDetails'));
    expect(details).not.toContain('<PromotionPicker');
    expect(details).not.toContain('data-product-promotions');
  });
});
