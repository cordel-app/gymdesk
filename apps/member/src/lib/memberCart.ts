// #2746 stage 2 — the member's shopping cart, decided.
//
// The cart is the member's Draft Product Set (#2496): the plans and recurring
// lines the Draft adds and, since #2746 stage 1, the one-time Products linked
// to it — plus, since #2949 stage 6, the member's **standalone** one-time
// purchases (`GET /me/cart/purchases`, linked to no Product Set): the Draft's
// Save & Pay pays them too (#2949 stage 5), and with no Draft they are a cart
// of their own, paid by `POST /me/cart/checkout`. This module only reads that Draft back — which items
// it holds, how many plans and products that is, which action commits it and
// which locale key explains a refusal. It resolves no `t()`, computes no money
// (the total is the server's review, `commitCharge()`'s figure) and spells no
// colour (`memberChrome.ts`'s `cartSummary*`); the page draws.
import {
  type MemberSetReview,
  type MemberSetView,
  draftErrorKey,
  purchaseErrorKey,
  setCommitAction,
  type SetCommitAction,
} from './memberProducts';

/** One one-time Product linked to the Draft (`GET /me/product-sets/:id`'s `purchases`). */
export interface MemberSetPurchase {
  id: number;
  product_id: number | null;
  product_name: string;
  product_type?: string | null;
  units?: number | null;
  status?: string;
  amount: number;
  list_price?: number | null;
  currency?: string | null;
  assigned_member_id?: number | null;
  image_thumbnail_url?: string | null;
  /** #3154 — the Product's own description and picture, and its applied Promotions. */
  description?: string | null;
  image_url?: string | null;
  promotions?: CartPromotion[];
}

/**
 * #3154 — a Promotion as the cart reads it beside a plan or a Product: a plan's
 * carries its Free / Paid / Bonus months and Membership Fee Benefit, a Product's
 * its treatment and the cycles it covers. Amounts are never shown.
 */
export interface CartPromotion {
  id?: number;
  promotion_id: number;
  promotion_name?: string | null;
  description?: string | null;
  image_url?: string | null;
  image_thumbnail_url?: string | null;
  promotion_image_url?: string | null;
  promotion_image_thumbnail_url?: string | null;
  free_months?: number | null;
  paid_months?: number | null;
  bonus_months?: number | null;
  membership_fee_benefit?: { action: string; value: number | null; duration_months: number | null } | null;
  benefit_action?: string | null;
  benefit_value?: number | null;
  duration_cycles?: number | null;
}

/** A standalone one-time purchase in the cart (`GET /me/cart/purchases`, #2949 stage 4). */
export interface MemberStandalonePurchase {
  id: number;
  product_id: number | null;
  product_name: string;
  amount: number;
  /** #3020 stage 7: the quantity (a Sessions Product: packages); `amount` is the total for it. */
  quantity?: number | null;
  currency?: string | null;
  cart_expires_at?: string | null;
}

/** The member's standalone cart as `GET /me/cart/purchases` answers it; `total` is the server's. */
export interface MemberStandaloneCart {
  purchases: MemberStandalonePurchase[];
  total: number | null;
  currency: string | null;
}

export const EMPTY_STANDALONE_CART: MemberStandaloneCart = { purchases: [], total: null, currency: null };

/** The Draft read as the cart needs it: the set view plus stage 1's two fields. */
export type MemberCartView = MemberSetView & {
  purchases?: MemberSetPurchase[];
  /** #2949 stage 6: the standalone purchases this version's checkout pays or is paying (the owner's read only). */
  cart_purchases?: MemberStandalonePurchase[];
  cart?: { plans: number; products: number };
  /** #2746 stage 3: a version awaiting payment — its initial event's amount (the owner's read only). */
  pending_amount?: number | null;
  /** #2895: a Draft staff created by assigning a plan, still being set up (the server's `awaitsStaffSetup()`). */
  awaiting_staff_setup?: boolean;
};

/** One removable item of the cart, with what its own Cancel calls. */
export type CartItem =
  | { kind: 'plan'; key: string; name: string; planSnapshotId: number; planId: number | null }
  | { kind: 'line'; key: string; name: string; lineId: number; productId: number }
  | { kind: 'purchase'; key: string; name: string; purchaseId: number; productId: number | null; amount: number; currency: string; standalone: boolean; quantity?: number };

/** The cart's commit: the Draft's own (#2496 stage 5), or the standalone cart's checkout (#2949 stage 6). */
export type CartCommitAction = SetCommitAction | 'cart_checkout';

function isDraft(view: MemberCartView | null): view is MemberCartView {
  return !!view && view.status === 'in_cart';
}

/**
 * #2746 stage 3 — the version the cart is read from: a Draft, or the same
 * purchase once its payment has started (§6 keeps it grouped as one).
 */
function isCartVersion(view: MemberCartView | null): view is MemberCartView {
  return !!view && (view.status === 'in_cart' || view.status === 'pending_payment');
}

/**
 * Which state the cart is in: being filled, awaiting its one payment, or
 * (#2895) a Draft staff are still setting up, which the member sees but can
 * neither pay, cancel nor add to until staff choose **Members App** as its
 * payment method (that is Save & Pay, so it then reads `pending_payment`).
 */
export type CartPhase = 'draft' | 'pending_payment' | 'awaiting_staff' | 'standalone';

function standaloneItems(purchases: MemberStandalonePurchase[] | undefined): CartItem[] {
  return (purchases ?? []).map((p) => ({
    kind: 'purchase', key: `standalone-${p.id}`, name: p.product_name,
    purchaseId: Number(p.id), productId: p.product_id == null ? null : Number(p.product_id),
    amount: Number(p.amount), currency: p.currency ?? 'EUR', standalone: true,
    quantity: Math.max(1, Number(p.quantity ?? 1)),
  }));
}

/** The Draft's own items: what the Product Set adds, no standalone purchase. */
function setItems(view: MemberCartView | null): CartItem[] {
  if (!isCartVersion(view)) return [];
  const plans: CartItem[] = (view.plans ?? [])
    .filter((p) => p.change === 'added' && !p.entitlement_only)
    .map((p) => ({
      kind: 'plan', key: `plan-${p.plan_snapshot_id}`, name: p.plan_name ?? '—',
      planSnapshotId: Number(p.plan_snapshot_id),
      planId: p.membership_plan_id == null ? null : Number(p.membership_plan_id),
    }));
  const lines: CartItem[] = view.lines
    .filter((l) => l.change === 'added')
    .map((l) => ({
      kind: 'line', key: `line-${l.id}`, name: l.product_name ?? '—',
      lineId: Number(l.id), productId: Number(l.product_id),
    }));
  const purchases: CartItem[] = (view.purchases ?? []).map((p) => ({
    kind: 'purchase', key: `purchase-${p.id}`, name: p.product_name,
    purchaseId: Number(p.id), productId: p.product_id == null ? null : Number(p.product_id),
    amount: Number(p.amount), currency: p.currency ?? 'EUR', standalone: false,
  }));
  return [...plans, ...lines, ...purchases];
}

/** The set's phase alone, ignoring standalone purchases (the pre-stage-6 answer). */
function setPhase(view: MemberCartView | null, viewerMemberId: number | null): Exclude<CartPhase, 'standalone'> | null {
  // #2949 stage 6: a checkout in flight may pay only standalone purchases it joined (stage 5).
  const joined = view?.status === 'pending_payment' ? view.cart_purchases?.length ?? 0 : 0;
  if (setItems(view).length + joined === 0) return null;
  if (awaitsStaffSetup(view)) return 'awaiting_staff';
  if (view!.status === 'in_cart') return 'draft';
  if (viewerMemberId == null || view!.owner_member_id !== viewerMemberId) return null;
  return 'pending_payment';
}

/** #2895: whether the Draft is the gym's, still being set up — the server's flag, never derived here. */
export function awaitsStaffSetup(view: MemberCartView | null): boolean {
  return !!view && view.status === 'in_cart' && view.awaiting_staff_setup === true;
}

/**
 * #2746 stage 3 — the cart's phase for the member looking at it, or `null`
 * when there is no cart to show. A version awaiting payment is a cart only for
 * its owner (the owner pays, #2123): a covered family member reads the family's
 * version, but it is not their purchase to pay or cancel.
 */
export function cartPhase(
  view: MemberCartView | null,
  viewerMemberId: number | null,
  standalone: MemberStandaloneCart = EMPTY_STANDALONE_CART,
): CartPhase | null {
  const phase = setPhase(view, viewerMemberId);
  if (phase) return phase;
  // #2949 stage 6: an owner's open Draft (even one adding nothing yet) is the cart the
  // standalone purchases join — its Save & Pay pays them (stage 5).
  if (standalone.purchases.length === 0) return null;
  if (isDraft(view) && !awaitsStaffSetup(view) && (viewerMemberId == null || view.owner_member_id === viewerMemberId)) return 'draft';
  return 'standalone';
}

/**
 * #3286 — the Pending Payment Product Set this cart card shows the member as
 * their own checkout, with its Pay / Cancel, or `null`. The same phase rule the
 * card renders by (`cartPhase()`), so the Home never hides a payment the card
 * does not carry: a family version the member is only covered by is not theirs.
 */
export function pendingCheckoutSetId(
  view: MemberCartView | null,
  viewerMemberId: number | null,
  standalone: MemberStandaloneCart = EMPTY_STANDALONE_CART,
): number | null {
  return view && cartPhase(view, viewerMemberId, standalone) === 'pending_payment' ? Number(view.id) : null;
}

/**
 * #2949 stage 6 — whether the standalone purchases are a cart card of their own
 * beside the set's: while the set's payment is in flight, or staff are still
 * setting it up, a purchase added since is not part of that checkout (§6) and
 * is paid on its own.
 */
export function separateStandaloneCart(
  view: MemberCartView | null,
  viewerMemberId: number | null,
  standalone: MemberStandaloneCart,
): boolean {
  if (standalone.purchases.length === 0) return false;
  const phase = setPhase(view, viewerMemberId);
  return phase === 'pending_payment' || phase === 'awaiting_staff';
}

/** The standalone cart card's items (its own phase, or beside a set awaiting payment). */
export function standaloneCartItems(standalone: MemberStandaloneCart): CartItem[] {
  return standaloneItems(standalone.purchases);
}

/**
 * #2949 stage 6 — seconds until the standalone purchases leave the cart (the
 * server's `cart_expires_at`, since #3274 the cart's one clock, the same for
 * every item and for the cart's Product Set), or `null` with none.
 */
export function standaloneSecondsLeft(standalone: MemberStandaloneCart, nowMs: number): number | null {
  const times = standalone.purchases
    .map((p) => (p.cart_expires_at ? Date.parse(p.cart_expires_at) : NaN))
    .filter((t) => Number.isFinite(t));
  if (times.length === 0) return null;
  return Math.max(0, Math.floor((Math.min(...times) - nowMs) / 1000));
}

/**
 * Whether an item may still leave the cart on its own: only while it is a
 * Draft. Once payment has started the purchase is one operation (§6).
 */
export function cartItemsRemovable(view: MemberCartView | null): boolean {
  return isDraft(view) && !awaitsStaffSetup(view);
}

/**
 * The amount a cart awaiting payment is being paid for: the initial event the
 * server reports (`pending_amount`). `null` outside that phase or when unknown —
 * never a figure added up here.
 */
export function cartPendingAmount(view: MemberCartView | null): number | null {
  if (!view || view.status !== 'pending_payment' || view.pending_amount == null) return null;
  const n = Number(view.pending_amount);
  return Number.isFinite(n) ? n : null;
}

/**
 * What the cart holds, each item once: the plans the Draft adds (not one the
 * member already holds, not one carried for entitlement only), the recurring
 * lines it adds and its one-time Products. A plan's included benefits are the
 * plan's, never items of their own (§4). Empty outside a Draft or a version
 * awaiting payment (stage 3: the same items stay grouped while it is paid).
 */
export function cartItems(
  view: MemberCartView | null,
  viewerMemberId: number | null = null,
  standalone: MemberStandaloneCart = EMPTY_STANDALONE_CART,
): CartItem[] {
  void viewerMemberId;
  if (isCartVersion(view)) {
    // #2949 stage 6: a checkout in flight lists the standalone purchases it joined (stage 5).
    if (view.status === 'pending_payment') return [...setItems(view), ...standaloneItems(view.cart_purchases)];
    // A Draft staff are still setting up is theirs; the member's standalone purchases stay beside it.
    if (awaitsStaffSetup(view)) return setItems(view);
    return [...setItems(view), ...standaloneItems(standalone.purchases)];
  }
  return standaloneItems(standalone.purchases);
}

/**
 * How many plans and products the cart holds: the server's own count
 * (`cartCounts()`) when the read carries it, else the same count over the
 * items above, so the two can only agree.
 */
export function cartCounts(
  view: MemberCartView | null,
  viewerMemberId: number | null = null,
  standalone: MemberStandaloneCart = EMPTY_STANDALONE_CART,
): { plans: number; products: number } {
  const items = cartItems(view, viewerMemberId, standalone);
  if (isCartVersion(view) && view.cart) {
    // The set's own count is the server's; the standalone purchases ride on top (#2949 stage 6).
    const extra = items.filter((i) => i.kind === 'purchase' && i.standalone).length;
    return { plans: Number(view.cart.plans), products: Number(view.cart.products) + extra };
  }
  return {
    plans: items.filter((i) => i.kind === 'plan').length,
    products: items.filter((i) => i.kind !== 'plan').length,
  };
}

/** Whether the version holds a cart at all: a Draft or a version awaiting payment, with at least one item. */
export function hasCart(
  view: MemberCartView | null,
  viewerMemberId: number | null = null,
  standalone: MemberStandaloneCart = EMPTY_STANDALONE_CART,
): boolean {
  return cartPhase(view, viewerMemberId, standalone) != null;
}

/**
 * The one action the cart's Pay commits with, from the server's review alone:
 * the Summary's own rule (#2496 stage 5) first; then, for a cart whose only
 * items are one-time Products (which the review's plan-and-line diff does not
 * list), Save & Pay while something is owed and the free activation when
 * nothing is. `null` while the review is missing, failed or not a Draft's —
 * the amount is never decided here.
 */
export function cartCommitAction(
  view: MemberCartView | null,
  review: MemberSetReview | null,
  viewerMemberId: number | null = null,
  standalone: MemberStandaloneCart = EMPTY_STANDALONE_CART,
): CartCommitAction | null {
  const phase = cartPhase(view, viewerMemberId, standalone);
  // #2949 stage 6: standalone purchases alone are paid by their own checkout, for the server's total.
  if (phase === 'standalone') return standalone.total != null && standalone.total > 0 ? 'cart_checkout' : null;
  if (phase !== 'draft' || awaitsStaffSetup(view)) return null;
  const summary = setCommitAction(review);
  if (summary) return summary;
  if (!review || review.status !== 'in_cart' || review.error || review.amount_due == null) return null;
  return review.payment_required ? 'save_and_pay' : 'activate';
}

/** The standalone card's own commit (beside a set awaiting payment): its checkout while something is owed. */
export function standaloneCommitAction(standalone: MemberStandaloneCart): 'cart_checkout' | null {
  return standalone.purchases.length > 0 && standalone.total != null && standalone.total > 0 ? 'cart_checkout' : null;
}

export type CartProductStateFull = { state: 'in_cart'; key: string } | { state: 'none' };

/**
 * Whether a one-time Product is in the cart, and the key of the item whose
 * Cancel removes it: a purchase the Draft carries, else (#2949 stage 6) a
 * standalone one.
 */
export function cartProductState(
  productId: number,
  view: MemberCartView | null,
  standalone: MemberStandaloneCart = EMPTY_STANDALONE_CART,
): CartProductStateFull {
  if (isDraft(view)) {
    const p = (view.purchases ?? []).find((x) => Number(x.product_id) === productId);
    if (p) return { state: 'in_cart', key: `purchase-${p.id}` };
  }
  const s = standalone.purchases.find((x) => Number(x.product_id) === productId);
  return s ? { state: 'in_cart', key: `standalone-${s.id}` } : { state: 'none' };
}

/** The route an item's own Cancel calls (the Draft's id for a set item). */
export function cartItemRemovePath(item: CartItem, setId: number | null): string | null {
  if (item.kind === 'purchase' && item.standalone) return `/me/cart/purchases/${item.purchaseId}`;
  if (setId == null) return null;
  if (item.kind === 'plan') return `/me/product-sets/${setId}/plans/${item.planSnapshotId}`;
  if (item.kind === 'line') return `/me/product-sets/${setId}/services/${item.lineId}`;
  return `/me/product-sets/${setId}/purchases/${item.purchaseId}`;
}

/**
 * Which locale key explains a refused cart edit: the cart's own refusal, a
 * Draft refusal (in flight, locked, expired), else the purchase's own codes
 * (a lapsed Promotion, a family member who left, an unpriced Product).
 */
export function cartErrorKey(message: string | null | undefined): string {
  switch (message) {
    case 'already_in_cart':
    case 'draft_exists': return 'membership.cart_error_already_in_cart';
    case 'one_per_member': return 'membership.cart_error_one_per_member';
    case 'family_owner_only': return 'membership.family_owner_only';
    case 'awaiting_staff_setup': return 'membership.cart_error_awaiting_staff';
    // #2949 stage 6: the standalone cart's checkout refusals (`POST /me/cart/checkout`).
    case 'cart_changed':
    case 'cart_empty':
    case 'nothing_to_pay':
    case 'purchase_not_in_cart': return 'membership.cart_error_changed';
    case 'family_owner_pays': return 'membership.cart_error_family_owner_pays';
    case 'in_flight':
    case 'edit_locked':
    case 'duplicate_submission':
    case 'draft_expired':
    case 'draft_has_plan':
    case 'plan_change_via_gym':
    case 'plan_not_removable':
      return draftErrorKey(message);
    default:
      return purchaseErrorKey(message);
  }
}

/**
 * #2746 stage 3 — which locale key explains a refused cancellation of a cart
 * awaiting payment (#2747's codes): the payment already went through, or its
 * outcome is still being processed; anything else is the generic refusal.
 */
export function pendingCartCancelErrorKey(message: string | null | undefined): string {
  switch (message) {
    case 'payment_settled': return 'membership.cart_pending_error_settled';
    case 'payment_unresolved': return 'membership.summary_error_unresolved';
    default: return 'membership.cart_pending_error_generic';
  }
}

/** #3020 stage 7: the quantity of a one-time purchase in the cart is a whole number from 1 to this (the API's limit). */
export const CART_PURCHASE_MAX_QUANTITY = 99;

/** The route that changes a standalone cart purchase's quantity (`PUT`, body `{ quantity }`), or null for any other item. */
export function cartItemQuantityPath(item: CartItem): string | null {
  return item.kind === 'purchase' && item.standalone ? `/me/cart/purchases/${item.purchaseId}` : null;
}

/** Whether a quantity may be sent: a whole number from 1 to the limit. */
export function isValidCartQuantity(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= CART_PURCHASE_MAX_QUANTITY;
}
