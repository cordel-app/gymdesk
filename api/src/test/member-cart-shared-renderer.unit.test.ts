// #2895 — Home and My Products draw the cart through one component
// (`CartCard`), and the Home card has no "Open my cart" button. In the API
// suite for #1009's reason: CI runs `npm test` in `api/` only.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const member = join(__dirname, '../../../apps/member');
const read = (p: string) => readFileSync(join(member, p), 'utf8');

describe('shared cart renderer', () => {
  it('#2973 stage 6: Home and My Products mount the one MemberCart and neither restates the card', () => {
    const home = read('src/app/[locale]/page.tsx');
    const page = read('src/app/[locale]/membership/page.tsx');
    expect(home).toContain('<MemberCart');
    expect(page).toContain('<MemberCart');
    expect(() => read('src/components/HomeCartCard.tsx')).toThrow();
    expect(page).not.toContain('<CartCard');
    expect(page).not.toContain('style={cartSummaryStyle}');
  });

  it('the cart carries its Summary, beneficiaries, countdown, actions and dialogs; the Add buttons stay outside it', () => {
    const cart = read('src/components/MemberCart.tsx');
    const card = read('src/components/CartCard.tsx');
    const page = read('src/app/[locale]/membership/page.tsx');
    expect(cart).toContain('<CartCard');
    expect(cart).toContain('cartBeneficiaryLabel');
    expect(cart).toContain('<CartSummary');
    expect(cart).toContain('data-draft-expiry');
    expect(cart).toContain('cart_discard_title');
    expect(cart).toContain('payment_consent');
    expect(cart).not.toContain('add_plan');
    expect(cart).not.toContain('add_product');
    expect(card).toContain('data-cart-beneficiary');
    expect(page).toContain('renderCartAddButtons');
    expect(page.indexOf('<MemberCart')).toBeLessThan(page.indexOf('{renderCartAddButtons(phase'));
  });

  it('says when staff are editing (locale keys exist)', () => {
    expect(read('src/components/MemberCart.tsx')).toContain('staffEditing');
    for (const l of ['en', 'es', 'ca']) {
      const msgs = JSON.parse(read(`locales/base/${l}.json`));
      expect(msgs.membership.cart_staff_editing).toBeTruthy();
      expect(msgs.home.cart_open).toBeUndefined();
    }
  });
});

// #3007 stage 5 — the Summary draws what the Draft marks for deletion.
describe('cart Summary pending deletions (#3007 stage 5)', () => {
  it('reads pending_deletion from the review and renders it in CartSummary', () => {
    expect(read('src/lib/memberProducts.ts')).toContain('reviewPendingDeletions');
    expect(read('src/components/CartSummary.tsx')).toContain('data-pending-deletion');
  });
});
