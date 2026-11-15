import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #2854 — the Add Product form shows the selected Product's thumbnail left of
// the Product selector, and each Promotion offered under it shows that same
// Product's thumbnail. No component-test infra exists for apps/admin, so —
// like promotion-picker-thumbnails.test.ts — this pins the wiring from source.

const FORM = readFileSync(join(__dirname, '..', 'app', '[locale]', 'members', 'AddProductPurchase.tsx'), 'utf8');

describe('Add Product thumbnails (#2854)', () => {
  it('draws the selected Product through the shared circular MemberAvatar at 40px, keyed on the Product', () => {
    expect(FORM).toMatch(/import \{ MemberAvatar \} from '@\/components\/MemberAvatar'/);
    expect(FORM).toContain('PRODUCT_SELECT_THUMBNAIL_SIZE = 40');
    expect(FORM).toMatch(/<MemberAvatar\s+key=\{product\.id\}\s+name=\{product\.name\}\s+imageUrl=\{product\.image_url \?\? null\}/);
  });

  it('places the thumbnail before (left of) the Product selector, only once one is selected', () => {
    const thumb = FORM.indexOf('data-product-thumbnail');
    const select = FORM.indexOf('id="add-product-select"');
    expect(thumb).toBeGreaterThan(0);
    expect(select).toBeGreaterThan(thumb);
    expect(FORM).toMatch(/\{product && \(\s*<span data-product-thumbnail>/);
  });

  it('gives every offered Promotion the selected Product’s thumbnail and asks the picker for thumbnails', () => {
    const cell = FORM.slice(FORM.indexOf('function productPromotionsCell'), FORM.indexOf('export function addProductDraftCells'));
    expect(cell).toContain('imageUrl: product.image_url ?? null');
    expect(cell).toMatch(/<PromotionPicker[\s\S]*?showThumbnails[\s\S]*?\/>/);
  });
});
