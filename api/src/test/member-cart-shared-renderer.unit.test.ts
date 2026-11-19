// #2895 — Home and My Products draw the cart through one component
// (`CartCard`), and the Home card has no "Open my cart" button. In the API
// suite for #1009's reason: CI runs `npm test` in `api/` only.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const member = join(__dirname, '../../../apps/member');
const read = (p: string) => readFileSync(join(member, p), 'utf8');

describe('shared cart renderer', () => {
  it('both pages render CartCard and neither restates the cart card markup', () => {
    const home = read('src/components/HomeCartCard.tsx');
    const page = read('src/app/[locale]/membership/page.tsx');
    expect(home).toContain('<CartCard');
    expect(page).toContain('<CartCard');
    expect(home).not.toContain('cartSummaryStyle');
    expect(page).not.toContain('style={cartSummaryStyle}');
  });

  it('the Home cart has no Open my cart button and says when staff are editing', () => {
    const home = read('src/components/HomeCartCard.tsx');
    expect(home).not.toContain('cart_open');
    expect(home).toContain('staffEditing');
    for (const l of ['en', 'es', 'ca']) {
      const msgs = JSON.parse(read(`locales/base/${l}.json`));
      expect(msgs.membership.cart_staff_editing).toBeTruthy();
      expect(msgs.home.cart_open).toBeUndefined();
    }
  });

  it('#2973 stage 4: the Summary sits inside the card on both pages and lines name their beneficiary', () => {
    const home = read('src/components/HomeCartCard.tsx');
    const page = read('src/app/[locale]/membership/page.tsx');
    const card = read('src/components/CartCard.tsx');
    expect(home).toContain('cartBeneficiaryLabel');
    expect(page).toContain('cartBeneficiaryLabel');
    expect(card).toContain('data-cart-beneficiary');
    expect(page).toContain("summary={review && setView?.status === 'in_cart' ? <CartSummary review={review} /> : undefined}");
    expect(page).toContain('!hasCart(setView, viewerId, standaloneCart) && <CartSummary');
  });
});

// #3007 stage 5 — the Summary draws what the Draft marks for deletion.
describe('cart Summary pending deletions (#3007 stage 5)', () => {
  it('reads pending_deletion from the review and renders it in CartSummary', () => {
    const lib = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../../apps/member/src/lib/memberProducts.ts'), 'utf8');
    const cmp = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../../apps/member/src/components/CartSummary.tsx'), 'utf8');
    expect(lib).toContain('reviewPendingDeletions');
    expect(cmp).toContain('data-pending-deletion');
  });
});
