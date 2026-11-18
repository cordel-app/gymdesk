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
  it('keeps Save and Cancel in the edited row, never behind the expander', () => {
    expect(src).toContain('if (editing?.rowId === item.id) return <AddProductActions form={editForm} />;');
    expect(src).not.toContain('setExpandedIds((prev) => new Set(prev).add(item.id))');
  });
  it('shows applied Promotions in their column and in the area below the row, read-only and editing', () => {
    expect(src).toContain("list.map((p) => p.promotion_name).join(', ')");
    expect(src).toContain('data-product-promotions');
    expect(src).toContain('disabled\n          emptyText=""\n          showThumbnails');
    expect(src).toContain('productPromotionsCell(editForm)');
  });
  it('does not show the draft hint while editing a row', () => {
    const feedback = form.slice(form.indexOf('export function AddProductFeedback'), form.indexOf('export function AddProductActions'));
    expect(feedback).not.toContain('add_product_simulation_recurring_hint');
  });
});
