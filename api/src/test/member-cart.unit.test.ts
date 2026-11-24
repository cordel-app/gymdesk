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
  cartItemRemovePath,
  hasCart,
  pendingCartCancelErrorKey,
  pendingCheckoutSetId,
  separateStandaloneCart,
  standaloneCommitAction,
  standaloneSecondsLeft,
  type MemberStandaloneCart,
} from '../../../apps/member/src/lib/memberCart';
import type { MemberSetReview } from '../../../apps/member/src/lib/memberProducts';

const REPO = join(__dirname, '..', '..', '..');
const MEMBER = join(REPO, 'apps', 'member');
const PAGE = join(MEMBER, 'src', 'app', '[locale]', 'membership', 'page.tsx');

function draft(over: Partial<MemberCartView> = {}): MemberCartView {
  return {
    id: 7,
    status: 'in_cart',
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
    product_set_id: 7, status: 'in_cart', summary_items: [], immediate_lines: [],
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
    expect(cartProductState(9, draft())).toEqual({ state: 'in_cart', key: 'purchase-31' });
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
    // #2973 stage 6: the cart is the shared MemberCart, which owns the route and the confirmation.
    const cart = readFileSync(join(MEMBER, 'src', 'components', 'MemberCart.tsx'), 'utf-8');
    expect(cart).toContain('/cancel`, { method: \'POST\' }');
    expect(cart).toContain('setConfirmPendingCancel(true)');
    expect(cart).toContain('headingKey="membership.cart_pending_heading"');
  });
});

describe('a Draft staff are still setting up (#2895)', () => {
  const staff = (over: Partial<MemberCartView> = {}) => draft({ awaiting_staff_setup: true, owner_member_id: 5, ...over } as any);

  it('is its own phase, with nothing to pay and no item removable', () => {
    expect(cartPhase(staff(), 5)).toBe('awaiting_staff');
    expect(cartCommitAction(staff(), review())).toBeNull();
    expect(cartCommitAction(staff({ lines: [], plans: [] }), review())).toBeNull();
    expect(cartItemsRemovable(staff())).toBe(false);
    // Its items are still listed and counted.
    expect(cartCounts(staff())).toEqual({ plans: 1, products: 2 });
  });

  it('the member’s own Draft is unchanged', () => {
    expect(cartPhase(draft({ awaiting_staff_setup: false } as any), 5)).toBe('draft');
    expect(cartItemsRemovable(draft())).toBe(true);
  });

  it('once staff choose Members App (Pending Payment) it is the owner’s pending cart', () => {
    const v = staff({ status: 'pending_payment', awaiting_staff_setup: false } as any);
    expect(cartPhase(v, 5)).toBe('pending_payment');
  });

  it('words its refusal as the gym preparing a change, never as awaiting payment', () => {
    expect(cartErrorKey('awaiting_staff_setup')).toBe('membership.cart_error_awaiting_staff');
    expect(cartErrorKey('awaiting_staff_setup')).not.toBe(cartErrorKey('in_flight'));
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

  it('adds a one-time Product to the cart instead of starting its own payment (#2949 stage 6: standalone, no Product Set)', () => {
    const confirm = page.slice(page.indexOf('async function confirmPurchase('), page.indexOf('// ── #1122 — Add Plan'));
    expect(confirm).toContain("apiFetch('/me/cart/purchases', {");
    expect(confirm).not.toContain('/me/product-sets/');
    expect(page).not.toContain('/me/products/${product.id}/purchase`');
  });

  // #2771 §1 — every purchasable Product reads *Add to cart*, recurring included:
  // there is no second, recurring-only *Add* action beside the cart.
  it('offers every Product, recurring or one-time, through the one cart wording', () => {
    const draftAction = page.slice(page.indexOf('function draftAction('), page.indexOf('function openPurchase('));
    expect(draftAction).toContain("t('membership.cart_add')");
    expect(draftAction).toContain("t('membership.cart_in_cart')");
    expect(draftAction).toContain("t('membership.cart_item_cancel')");
    for (const retired of ['product_add_to_draft', 'product_in_draft', 'product_remove_from_draft']) {
      expect(page).not.toContain(`membership.${retired}`);
      for (const code of ['en', 'es', 'ca']) {
        const ns = JSON.parse(readFileSync(join(MEMBER, 'locales', 'base', `${code}.json`), 'utf-8')).membership;
        expect(ns[retired]).toBeUndefined();
      }
    }
  });

  it('asks before the global Cancel discards the whole Draft', () => {
    const cart = readFileSync(join(MEMBER, 'src', 'components', 'MemberCart.tsx'), 'utf-8');
    expect(cart).toContain('setConfirmDiscard(true)');
    expect(cart).toContain("t('membership.cart_discard_body')");
  });

  it('spells no colour of its own: the cart card is memberChrome’s', () => {
    expect(readFileSync(join(MEMBER, 'src', 'lib', 'memberCart.ts'), 'utf-8')).not.toMatch(/['"`]#[0-9a-fA-F]{3,8}\b/);
    expect(page).toContain('cartSummaryStyle');
  });
});

// #2949 stage 6 — the member's standalone one-time purchases (`GET /me/cart/purchases`,
// linked to no Product Set) are part of the one cart.
describe('standalone purchases in the cart (#2949 stage 6)', () => {
  const standalone = (over: Partial<MemberStandaloneCart> = {}): MemberStandaloneCart => ({
    purchases: [
      { id: 41, product_id: 15, product_name: 'Water bottle', amount: 12, currency: 'EUR', cart_expires_at: '2026-11-17T08:00:00.000Z' },
      { id: 42, product_id: 16, product_name: 'Towel', amount: 8, currency: 'EUR', cart_expires_at: '2026-11-17T07:30:00.000Z' },
    ],
    total: 20, currency: 'EUR', ...over,
  });
  const empty = draft({ lines: [], plans: [], purchases: [], owner_member_id: 5 } as any);

  it('are a cart of their own when there is no Draft, paid by their own checkout', () => {
    expect(cartPhase(null, 5, standalone())).toBe('standalone');
    expect(cartItems(null, 5, standalone()).map((i) => i.key)).toEqual(['standalone-41', 'standalone-42']);
    expect(cartCounts(null, 5, standalone())).toEqual({ plans: 0, products: 2 });
    expect(hasCart(null, 5, standalone())).toBe(true);
    expect(cartCommitAction(null, null, 5, standalone())).toBe('cart_checkout');
    expect(cartCommitAction(null, null, 5, standalone({ total: 0 }))).toBeNull();
  });

  it('join the member’s Draft, whose Save & Pay pays them (stage 5), even a Draft adding nothing yet', () => {
    const v = draft({ owner_member_id: 5 } as any);
    expect(cartPhase(v, 5, standalone())).toBe('draft');
    expect(cartItems(v, 5, standalone()).map((i) => i.key))
      .toEqual(['plan-21', 'line-11', 'purchase-31', 'standalone-41', 'standalone-42']);
    expect(cartCounts(v, 5, standalone({}))).toEqual({ plans: 1, products: 4 });
    expect(cartPhase(empty, 5, standalone())).toBe('draft');
    expect(cartCommitAction(empty, review(), 5, standalone())).toBe('save_and_pay');
  });

  it('list the purchases a checkout in flight joined, and a later one beside it as its own cart (§6)', () => {
    const pending = draft({ status: 'pending_payment', owner_member_id: 5, lines: [], plans: [], purchases: [],
      cart_purchases: [{ id: 41, product_id: 15, product_name: 'Water bottle', amount: 12 }] } as any);
    expect(cartPhase(pending, 5)).toBe('pending_payment');
    expect(cartItems(pending, 5).map((i) => i.key)).toEqual(['standalone-41']);
    const later = standalone({ purchases: [{ id: 43, product_id: 17, product_name: 'Lock', amount: 5 }], total: 5 });
    expect(cartPhase(pending, 5, later)).toBe('pending_payment');
    expect(separateStandaloneCart(pending, 5, later)).toBe(true);
    expect(standaloneCommitAction(later)).toBe('cart_checkout');
    expect(separateStandaloneCart(draft({ owner_member_id: 5 } as any), 5, later)).toBe(false);
  });

  it('never fold into a Draft staff are still setting up', () => {
    const staff = draft({ awaiting_staff_setup: true, owner_member_id: 5 } as any);
    expect(cartPhase(staff, 5, standalone())).toBe('awaiting_staff');
    expect(cartItems(staff, 5, standalone()).some((i) => i.key.startsWith('standalone-'))).toBe(false);
    expect(separateStandaloneCart(staff, 5, standalone())).toBe(true);
    expect(cartCommitAction(staff, review(), 5, standalone())).toBeNull();
  });

  it('knows a standalone Product is in the cart, and removes it through its own route', () => {
    expect(cartProductState(15, null, standalone())).toEqual({ state: 'in_cart', key: 'standalone-41' });
    const item = cartItems(null, 5, standalone())[0];
    expect(cartItemRemovePath(item, null)).toBe('/me/cart/purchases/41');
    const line = cartItems(draft(), 5)[1];
    expect(cartItemRemovePath(line, 7)).toBe('/me/product-sets/7/services/11');
  });

  it('count down to the first purchase leaving the cart (#2962)', () => {
    expect(standaloneSecondsLeft(standalone(), Date.parse('2026-11-17T07:00:00.000Z'))).toBe(1800);
    expect(standaloneSecondsLeft(standalone({ purchases: [] }), Date.now())).toBeNull();
  });

  it('read the standalone checkout’s refusals in the member’s language', () => {
    expect(cartErrorKey('cart_changed')).toBe('membership.cart_error_changed');
    expect(cartErrorKey('nothing_to_pay')).toBe('membership.cart_error_changed');
    expect(cartErrorKey('family_owner_pays')).toBe('membership.cart_error_family_owner_pays');
  });

  it('the page reads them and pays them through their own checkout', () => {
    const page = readFileSync(PAGE, 'utf-8');
    expect(page).toContain("apiFetch<MemberStandaloneCart>('/me/cart/purchases')");
    expect(page).toContain("'/me/cart/checkout', { method: 'POST' }");
  });
});

// #3286 — the Home leaves the cart card's own checkout to the card.
describe('pendingCheckoutSetId', () => {
  it('names the owner\'s Pending Payment Product Set the card shows', () => {
    expect(pendingCheckoutSetId(draft({ status: 'pending_payment', owner_member_id: 5 }), 5)).toBe(7);
  });

  it('names none for a Draft, a family version the member is only covered by, or no cart', () => {
    expect(pendingCheckoutSetId(draft({ owner_member_id: 5 }), 5)).toBeNull();
    expect(pendingCheckoutSetId(draft({ status: 'pending_payment', owner_member_id: 5 }), 6)).toBeNull();
    expect(pendingCheckoutSetId(null, 5)).toBeNull();
  });
});
