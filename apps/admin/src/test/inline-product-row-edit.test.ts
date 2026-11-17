import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #3020 — `⋮ → Edit` on a Draft line turns the row itself into the add form; no panel opens below it,
// and the applied Promotions stay visible in the Product cell in read-only mode.
// apps/admin has no component-test infra, so the wiring is pinned by source scan.
const src = readFileSync(join(__dirname, '..', 'app', '[locale]', 'members', 'MemberPurchasedProducts.tsx'), 'utf8');

describe('#3020 inline product row editing', () => {
  it('draws the edit form cells in the row, not a second form below it', () => {
    expect(src).not.toContain('<EditDraftLineForm');
    expect(src).toContain('editing?.rowId === item.id ? editCells[key]');
    expect(src).toContain('data-edit-product-quantity');
  });
  it('keeps every applied Promotion visible in read-only mode', () => {
    expect(src).toContain('item.promotions && item.promotions.length > 0');
    expect(src).toContain('data-product-promotion');
  });
});
