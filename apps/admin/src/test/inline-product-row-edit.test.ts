import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #3020 — `⋮ → Edit` on a Draft line turns the row itself into the form: Quantity is a column, Save/Cancel
// sit in the row's action cell, and the applied Promotions stay in their column and in the area below the row.
// apps/admin has no component-test infra, so the wiring is pinned by source scan.
const dir = join(__dirname, '..', 'app', '[locale]', 'members');
const src = readFileSync(join(dir, 'MemberPurchasedProducts.tsx'), 'utf8');
const form = readFileSync(join(dir, 'AddProductPurchase.tsx'), 'utf8');

describe('#3020 inline product row editing', () => {
  it('draws the edit form cells in the row, not a second form below it', () => {
    expect(src).not.toContain('<EditDraftLineForm');
    expect(src).not.toContain('<AddProductDetails form={editForm}');
    expect(src).toContain('editing?.rowId === item.id ? editCells[key]');
  });
  it('has a Quantity column right after Product, editable in the row', () => {
    const product = src.indexOf("key: 'product'");
    const quantity = src.indexOf("key: 'quantity'");
    const assigned = src.indexOf("key: 'assigned_to'");
    expect(product).toBeGreaterThan(-1);
    expect(quantity).toBeGreaterThan(product);
    expect(assigned).toBeGreaterThan(quantity);
    expect(src).toContain('item.quantity ?? 1');
    expect(src).toContain('data-edit-product-quantity');
  });
  it('places Save and Cancel bottom-left of the edited product, never behind the expander (#3021)', () => {
    expect(src).toContain('<div style={{ padding: \'4px 16px 8px\' }}><AddProductActions form={editForm} /></div>');
    expect(src).toContain('if (editing?.rowId === item.id) return null;');
    expect(src).not.toContain('setExpandedIds((prev) => new Set(prev).add(item.id))');
  });
  it('shows applied Promotions in their column and indented in the product line, read-only and editing (#3020 stage 3)', () => {
    expect(src).toContain("list.map((p) => p.promotion_name).join(', ')");
    expect(src).toContain('data-product-promotions');
    expect(src).toContain('disabled\n          emptyText=""\n          showThumbnails');
    // The area is drawn inside the product cell, not as a block below the row.
    expect(src).toContain('{promotionsArea(item)}');
    expect(src).not.toContain('              {promotionsArea(item)}\n              {editing?.rowId');
    expect(src).toContain('addProductDraftCells(editForm, null, { frequencyInCell: false })');
    expect(src).not.toContain('promotionsInCell: false');
  });
  it('does not show the draft hint while editing a row', () => {
    const feedback = form.slice(form.indexOf('export function AddProductFeedback'), form.indexOf('export function AddProductActions'));
    expect(feedback).not.toContain('add_product_simulation_recurring_hint');
  });
  it('shows the thumbnail (opens the Product modal), the frequency in its own column (#3088) and the tax in the expanded row (#3021)', () => {
    expect(src).toContain('data-product-thumbnail');
    expect(src).toContain('setImageOf(item)');
    expect(src).toContain('<ProfessionalServiceImageModal');
    expect(src).toContain('data-product-frequency');
    expect(src).toContain("t('purchase_exp_tax')");
    expect(src).not.toContain("key: 'tax'");
    expect(src).toContain('data-product-facts');
  });
});
