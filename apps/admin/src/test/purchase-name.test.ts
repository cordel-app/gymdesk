// #3270 / #3288 — a purchase is headed by its stored canonical name, verbatim, with its status as a
// separate badge, and the Summary's Initial Payment states each line's Source through the one label
// rule Billing Event details use.
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { purchaseStatusKey } from '@/lib/purchaseName';

const members = path.join(__dirname, '..', 'app', '[locale]', 'members');
const read = (f: string) => fs.readFileSync(path.join(members, f), 'utf8');

describe('purchase name (#3270)', () => {
  it('labels every purchase status, and none that is not one', () => {
    expect(purchaseStatusKey('in_cart')).toBe('product_set_status_in_cart');
    expect(purchaseStatusKey('pending_payment')).toBe('product_set_status_pending_payment');
    expect(purchaseStatusKey('completed')).toBe('purchase_status_completed');
    expect(purchaseStatusKey('cancelled')).toBe('purchase_status_cancelled');
    expect(purchaseStatusKey('draft')).toBeNull();
  });

  it('the Summary hosts head a purchase with PurchaseHeading, which shows the stored name verbatim', () => {
    expect(read('ProductSetsInFlight.tsx')).toContain('<PurchaseHeading');
    expect(read('StandaloneCartSummary.tsx')).toContain('<PurchaseHeading');
    const heading = read('PurchaseHeading.tsx');
    expect(heading).toContain('{purchase.name}');
    expect(heading).not.toContain("t('purchase_name'");
    expect(heading).not.toMatch(/Intl\.DateTimeFormat|toLocale/);
    expect(heading).toContain('<StatusBadge');
    for (const loc of ['en', 'es', 'ca']) {
      const json = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'locales', 'base', `${loc}.json`), 'utf8'));
      expect(json.members.purchase_name).toBeUndefined();
      expect(json.members.purchase_status_completed).toBeTruthy();
      expect(json.members.purchase_status_cancelled).toBeTruthy();
    }
  });

  it("the Initial Payment's Source column uses the Billing Event line-source rule", () => {
    const src = read('CheckoutSummarySections.tsx');
    expect(src).toContain('lineSourceLabelKey(l.source)');
    expect(src).toContain("tLine('col_line_source')");
  });
});
