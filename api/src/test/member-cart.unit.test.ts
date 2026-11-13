// #2746 stage 2 — the Members App's shopping cart, decided in
// `apps/member/src/lib/memberCart.ts` over the member's Draft Product Set read
// (`GET /me/product-sets/:id`, stage 1's `purchases` and `cart`). The cart's
// API half is covered by `me-cart-one-time-products.test.ts`; this file pins
// what the page reads back from it: which items the cart holds, the counts,
// which action Pay commits with, and that a one-time Product is added to the
// cart rather than bought on its own.
//
// In the API suite for #1009's reason: CI runs `npm test` in `api/` only.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  type MemberCartView,
  cartCommitAction,
  cartCounts,
  cartErrorKey,
  cartItems,
  cartItemsRemovable,
  cartPendingAmount,
  cartPhase,
  cartProductState,
  hasCart,
  pendingCartCancelErrorKey,
} from '../../../apps/member/src/lib/memberCart';
import type { MemberSetReview } from '../../../apps/member/src/lib/memberProducts';

const REPO = join(__dirname, '..', '..', '..');
const MEMBER = join(REPO, 'apps', 'member');
const PAGE = join(MEMBER, 'src', 'app', '[locale]', 'membership', 'page.tsx');

function draft(over: Partial<MemberCartView> = {}): MemberCartView {
  return {
    id: 7,
    status: 'draft',
    lines: [
      { id: 11, product_id: 3, change: 'added', product_name: 'Locker' },
      { id: 12, product_id: 4, change: 'inherited', product_name: 'Towel' },
    ],
    plans: [
      { plan_snapshot_id: 21, membership_plan_id: 2, plan_name: 'Gold', change: 'added' },
      { plan_snapshot_id: 22, membership_plan_id: 1, plan_name: 'Silver', change: 'inherited' },
      { plan_snapshot_id: 23, membership_plan_id: 5, plan_name: 'Old', change: 'added', entitlement_only: true },
    ],
    purchases: [{ id: 31, product_id: 9, product_name: '10 PT sessions', amount: 120, currency: 'EUR' }],
    ...over,
  };
}

function review(over: Partial<MemberSetReview> = {}): MemberSetReview {
  return {
    product_set_id: 7, status: 'draft', summary_items: [], immediate_lines: [],
    amount_due: 120, payment_required: true, tax_total: null, currency: 'EUR', error: null,
    ...over,
  };
}

describe('what the cart holds (§3/§4)', () => {
  it('lists the plans and lines the Draft adds and its one-time Products, never an inherited or entitlement-only one', () => {
    const items = cartItems(draft());
    expect(items.map((i) => i.key)).toEqual(['plan-21', 'line-11', 'purchase-31']);
    expect(items[2]).toMatchObject({ kind: 'purchase', purchaseId: 31, amount: 120, currency: 'EUR' });
  });

  it('counts plans apart from products, preferring the server’s own count', () => {
    expect(cartCounts(draft())).toEqual({ plans: 1, products: 2 });
    expect(cartCounts(draft({ cart: { plans: 1, products: 5 } }))).toEqual({ plans: 1, products: 5 });
  });

  it('is empty outside a Draft or a version awaiting payment', () => {
    expect(hasCart(draft({ status: 'active' }))).toBe(false);
    expect(cartItems(draft({ status: 'superseded' }))).toEqual([]);
    expect(hasCart(null)).toBe(false);
    expect(hasCart(draft({ lines: [], plans: [], purchases: [] }))).toBe(false);
  });

  it('knows which one-time Product is in the cart and which purchase removes it', () => {
    expect(cartProductState(9, draft())).toEqual({ state: 'in_cart', purchaseId: 31 });
    expect(cartProductState(3, draft())).toEqual({ state: 'none' });
    expect(cartProductState(9, draft({ status: 'pending_payment' }))).toEqual({ state: 'none' });
  });
});

describe('the cart awaiting payment (#2746 stage 3, §6)', () => {
  const pending = (over: Partial<MemberCartView> = {}) => draft({ status: 'pending_payment', owner_member_id: 5, pending_amount: 160, ...over });

  it('keeps the same items grouped as one purchase once payment has started', () => {
    expect(cartItems(pending()).map((i) => i.key)).toEqual(['plan-21', 'line-11', 'purchase-31']);
    expect(cartCounts(pending())).toEqual({ plans: 1, products: 2 });
  });

  it('is the owner’s cart only: a covered family member is shown no pending purchase', () => {
    expect(cartPhase(pending(), 5)).toBe('pending_payment');
    expect(cartPhase(pending(), 6)).toBeNull();
    expect(cartPhase(pending(), null)).toBeNull();
    expect(cartPhase(draft(), 6)).toBe('draft');
    expect(cartPhase(draft({ lines: [], plans: [], purchases: [] }), 5)).toBeNull();
  });

  it('lets no item leave on its own while payment is in progress', () => {
    expect(cartItemsRemovable(draft())).toBe(true);
    expect(cartItemsRemovable(pending())).toBe(false);
  });

  it('shows the amount the server reports for the initial payment, never one added up here', () => {
    expect(cartPendingAmount(pending())).toBe(160);
    expect(cartPendingAmount(pending({ pending_amount: null }))).toBeNull();
    expect(cartPendingAmount(draft({ pending_amount: 160 }))).toBeNull();
  });

  it('never offers a one-time Product as “in the cart” to add or remove while paying', () => {
    expect(cartProductState(9, pending())).toEqual({ state: 'none' });
  });

  it('explains a refused cancellation by #2747’s codes', () => {
    expect(pendingCartCancelErrorKey('payment_settled')).toBe('membership.cart_pending_error_settled');
    expect(pendingCartCancelErrorKey('payment_unresolved')).toBe('membership.summary_error_unresolved');
    expect(pendingCartCancelErrorKey('boom')).toBe('membership.cart_pending_error_generic');
  });

  it('cancels the whole purchase through #2747’s route, after a confirmation', () => {
    const page = readFileSync(PAGE, 'utf-8');
    expect(page).toContain('/cancel`, { method: \'POST\' }');
    expect(page).toContain('setConfirmPendingCancel(true)');
    expect(page).toContain("t('membership.cart_pending_heading')");
  });
});

describe('the cart’s Pay (§5)', () => {
  it('pays a cart holding only one-time Products, which the review’s diff does not list', () => {
    const v = draft({ lines: [], plans: [] });
    expect(cartCommitAction(v, review())).toBe('save_and_pay');
    expect(cartCommitAction(v, review({ amount_due: 0, payment_required: false }))).toBe('activate');
  });

  it('commits nothing while the review is missing, failed or not a Draft’s', () => {
    expect(cartCommitAction(draft(), null)).toBeNull();
    expect(cartCommitAction(draft(), review({ error: 'edit_locked' }))).toBeNull();
    expect(cartCommitAction(draft(), review({ amount_due: null }))).toBeNull();
    expect(cartCommitAction(draft(), review({ status: 'pending_payment' }))).toBeNull();
    expect(cartCommitAction(draft({ lines: [], plans: [], purchases: [] }), review())).toBeNull();
  });
});

describe('refusals', () => {
  it('reads every cart refusal in the member’s language', () => {
    expect(cartErrorKey('already_in_cart')).toBe('membership.cart_error_already_in_cart');
    expect(cartErrorKey('draft_exists')).toBe('membership.cart_error_already_in_cart');
    expect(cartErrorKey('one_per_member')).toBe('membership.cart_error_one_per_member');
    expect(cartErrorKey('in_flight')).toBe('membership.draft_error_in_flight');
    expect(cartErrorKey('promotion_not_applicable')).toBe('membership.promotion_unavailable_error');
    expect(cartErrorKey(undefined)).toBe('membership.product_purchase_error');
  });

  it('every key the cart resolves exists in all three locales', () => {
    const page = readFileSync(PAGE, 'utf-8');
    const lib = readFileSync(join(MEMBER, 'src', 'lib', 'memberCart.ts'), 'utf-8');
    const used = new Set([...`${page}\n${lib}`.matchAll(/membership\.(cart_[a-z_]+)/g)].map((m) => m[1]));
    expect(used.size).toBeGreaterThan(10);
    for (const code of ['en', 'es', 'ca']) {
      const ns = JSON.parse(readFileSync(join(MEMBER, 'locales', 'base', `${code}.json`), 'utf-8')).membership;
      for (const key of used) expect(ns[key], `${code}.membership.${key}`).toBeTruthy();
    }
  });
});

describe('the page (§1–§2)', () => {
  const page = readFileSync(PAGE, 'utf-8');

  it('adds a one-time Product to the Draft instead of starting its own payment', () => {
    expect(page).toContain('/purchases`');
    expect(page).not.toContain('/me/products/${product.id}/purchase`');
  });

  it('asks before the global Cancel discards the whole Draft', () => {
    expect(page).toContain('setConfirmDiscard(true)');
    expect(page).toContain("t('membership.cart_discard_body')");
  });

  it('spells no colour of its own: the cart card is memberChrome’s', () => {
    expect(readFileSync(join(MEMBER, 'src', 'lib', 'memberCart.ts'), 'utf-8')).not.toMatch(/['"`]#[0-9a-fA-F]{3,8}\b/);
    expect(page).toContain('cartSummaryStyle');
  });
});
