// #2746 stage 2 — the member's shopping cart, decided.
//
// The cart **is** the member's Draft Product Set (#2496): the plans and
// recurring lines the Draft adds and, since #2746 stage 1, the one-time
// Products linked to it. This module only reads that Draft back — which items
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
}

/** The Draft read as the cart needs it: the set view plus stage 1's two fields. */
export type MemberCartView = MemberSetView & {
  purchases?: MemberSetPurchase[];
  cart?: { plans: number; products: number };
  /** #2746 stage 3: a version awaiting payment — its initial event's amount (the owner's read only). */
  pending_amount?: number | null;
};

/** One removable item of the cart, with what its own Cancel calls. */
export type CartItem =
  | { kind: 'plan'; key: string; name: string; planSnapshotId: number; planId: number | null }
  | { kind: 'line'; key: string; name: string; lineId: number; productId: number }
  | { kind: 'purchase'; key: string; name: string; purchaseId: number; productId: number | null; amount: number; currency: string };

function isDraft(view: MemberCartView | null): view is MemberCartView {
  return !!view && view.status === 'draft';
}

/**
 * #2746 stage 3 — the version the cart is read from: a Draft, or the same
 * purchase once its payment has started (§6 keeps it grouped as one).
 */
function isCartVersion(view: MemberCartView | null): view is MemberCartView {
  return !!view && (view.status === 'draft' || view.status === 'pending_payment');
}

/** Which state the cart is in: being filled, or awaiting its one payment. */
export type CartPhase = 'draft' | 'pending_payment';

/**
 * #2746 stage 3 — the cart's phase for the member looking at it, or `null`
 * when there is no cart to show. A version awaiting payment is a cart only for
 * its owner (the owner pays, #2123): a covered family member reads the family's
 * version, but it is not their purchase to pay or cancel.
 */
export function cartPhase(view: MemberCartView | null, viewerMemberId: number | null): CartPhase | null {
  if (!hasCart(view)) return null;
  if (view!.status === 'draft') return 'draft';
  if (viewerMemberId == null || view!.owner_member_id !== viewerMemberId) return null;
  return 'pending_payment';
}

/**
 * Whether an item may still leave the cart on its own: only while it is a
 * Draft. Once payment has started the purchase is one operation (§6).
 */
export function cartItemsRemovable(view: MemberCartView | null): boolean {
  return isDraft(view);
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
export function cartItems(view: MemberCartView | null): CartItem[] {
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
    amount: Number(p.amount), currency: p.currency ?? 'EUR',
  }));
  return [...plans, ...lines, ...purchases];
}

/**
 * How many plans and products the cart holds: the server's own count
 * (`cartCounts()`) when the read carries it, else the same count over the
 * items above, so the two can only agree.
 */
export function cartCounts(view: MemberCartView | null): { plans: number; products: number } {
  if (!isCartVersion(view)) return { plans: 0, products: 0 };
  if (view.cart) return { plans: Number(view.cart.plans), products: Number(view.cart.products) };
  const items = cartItems(view);
  return {
    plans: items.filter((i) => i.kind === 'plan').length,
    products: items.filter((i) => i.kind !== 'plan').length,
  };
}

/** Whether the version holds a cart at all: a Draft or a version awaiting payment, with at least one item. */
export function hasCart(view: MemberCartView | null): boolean {
  const { plans, products } = cartCounts(view);
  return plans + products > 0;
}

/**
 * The one action the cart's Pay commits with, from the server's review alone:
 * the Summary's own rule (#2496 stage 5) first; then, for a cart whose only
 * items are one-time Products (which the review's plan-and-line diff does not
 * list), Save & Pay while something is owed and the free activation when
 * nothing is. `null` while the review is missing, failed or not a Draft's —
 * the amount is never decided here.
 */
export function cartCommitAction(view: MemberCartView | null, review: MemberSetReview | null): SetCommitAction | null {
  const summary = setCommitAction(review);
  if (summary) return summary;
  if (!review || review.status !== 'draft' || review.error || review.amount_due == null) return null;
  if (!hasCart(view)) return null;
  return review.payment_required ? 'save_and_pay' : 'activate';
}

/** Whether a one-time Product is already in the cart, and which purchase removes it. */
export type CartProductState = { state: 'in_cart'; purchaseId: number } | { state: 'none' };

export function cartProductState(productId: number, view: MemberCartView | null): CartProductState {
  if (!isDraft(view)) return { state: 'none' };
  const p = (view.purchases ?? []).find((x) => Number(x.product_id) === productId);
  return p ? { state: 'in_cart', purchaseId: Number(p.id) } : { state: 'none' };
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
