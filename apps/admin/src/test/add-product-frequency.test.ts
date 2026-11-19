import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #3021 stage 3 — the billing frequency stays visible in the product cell while a row is
// being added or edited (the read-only row already shows it). Wiring pinned from source,
// like add-product-thumbnails.test.ts.
const FORM = readFileSync(join(__dirname, '..', 'app', '[locale]', 'members', 'AddProductPurchase.tsx'), 'utf8');

describe('Add/Edit Product cell shows the billing frequency (#3021)', () => {
  it('renders the selected Product’s frequency from the existing label helper, after the selector', () => {
    const cell = FORM.slice(FORM.indexOf('export function addProductDraftCells'));
    expect(cell).toMatch(/\{product && \(\s*<div data-product-frequency/);
    expect(cell).toContain('billingFrequencyLabel(product.billing_frequency, f.tFreq)');
    expect(cell.indexOf('data-product-frequency')).toBeGreaterThan(cell.indexOf('id="add-product-select"'));
  });
});
