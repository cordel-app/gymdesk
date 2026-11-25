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

  // #3381 stage 2 — the owner's column order replaced the Source column (#3270) and the Price column
  // (#3282 stage 3): Product, Qty, Base Price, Benefit / Discount / Proration, VAT, VAT Amount, Amount.
  it("the Initial Payment's columns are the owner's seven, in order, and the proration is a treatment line", () => {
    const src = read('CheckoutSummarySections.tsx');
    const full = src.slice(src.indexOf("<div data-initial-payment style"));
    const order = ['checkout_col_product', 'checkout_col_quantity', 'checkout_col_base_price', 'checkout_col_discount',
      'checkout_col_tax_rate', 'checkout_col_tax', 'checkout_col_amount'].map((k) => full.indexOf(`t('${k}')`));
    for (const i of order) expect(i).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(src).not.toContain("tLine('col_line_source')");
    expect(src).not.toContain("t('checkout_col_price')");
    const treatments = src.slice(src.indexOf('data-line-treatments'));
    expect(treatments.indexOf("t('checkout_line_proration_label')")).toBeGreaterThan(-1);
    expect(src).toContain('basePriceFormula(l.base_price_breakdown, money)');
  });
});
