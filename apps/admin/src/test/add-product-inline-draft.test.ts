import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #1657 stage 1 — the inline Add Product row of the recurring section is the
// first item of the list, wears a Draft badge, and Save / Cancel are distinct.
// apps/admin has no component-test infra, so this pins the wiring by source scan.
const DIR = join(__dirname, '..', 'app', '[locale]', 'members');
const LOCALES = join(__dirname, '..', '..', 'locales', 'base');

describe('#1657 inline draft Add Product', () => {
  const list = readFileSync(join(DIR, 'MemberRecurringProducts.tsx'), 'utf8');
  const form = readFileSync(join(DIR, 'AddProductPurchase.tsx'), 'utf8');

  it('renders the form before the lines', () => {
    expect(list.indexOf('<AddProductPurchase')).toBeGreaterThan(-1);
    expect(list.indexOf('<AddProductPurchase')).toBeLessThan(list.indexOf('{lines.map('));
  });

  it('shows a Draft badge and a Save button for a recurring Product', () => {
    expect(form).toContain('data-add-product-draft-badge');
    expect(form).toContain("t('add_product_save_draft')");
    expect(form).toContain("t('add_product_cancel')");
  });

  it.each(['en', 'es', 'ca'])('%s has the new keys', (loc) => {
    const raw = readFileSync(join(LOCALES, `${loc}.json`), 'utf8');
    expect(raw).toContain('"add_product_save_draft"');
    expect(raw).toContain('"add_product_draft_badge"');
  });
});
