import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #3537 stage 2 — a one-time Product the member bought is listed in My Products with its
// name, details and status (*Pending payment* included) and NO action: Pay and Cancel on a
// purchase awaiting payment belong to the Purchases tab only. In the API suite for #1009's
// reason: CI runs `npm test` in `api/` only.

const MEMBER = join(__dirname, '..', '..', '..', 'apps', 'member');

function source(...parts: string[]): string {
  return readFileSync(join(MEMBER, ...parts), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const page = source('src', 'app', '[locale]', 'membership', 'page.tsx');
const history = source('src', 'components', 'PurchaseHistoryList.tsx');

function ownPurchaseCards(): string {
  const start = page.indexOf('function ownPurchaseCardItems(');
  expect(start).toBeGreaterThan(-1);
  const end = page.indexOf('\n  }\n', start);
  return page.slice(start, end);
}

describe('#3537 stage 2 — My Products purchase card', () => {
  it('shows the status pill and no button', () => {
    const cards = ownPurchaseCards();
    expect(cards).toContain('<StatusPill');
    expect(cards).not.toContain('<button');
    expect(cards).not.toContain('setCancellingPurchase');
  });

  it('keeps Pay and Cancel on the Purchases tab', () => {
    expect(page).toContain('onPay={payHistoryPurchase}');
    expect(page).toMatch(/onCancel=\{\(p\) =>/);
    expect(history).toContain("text('purchases.pay')");
    expect(history).toContain("text('purchases.cancel')");
  });
});
