// #1121 stage 2 — what a member *buying* a Product means: the states a
// purchase can be in, whether a given Product may be bought at all, and the
// snapshot a purchase is written with.
//
// The split is stage 1's and `me-billing-forecast.ts`' (#1123): this module is
// pure — no DB, no provider, no `t()` — and `api/src/api/me-products.ts` is the
// I/O half that reads the catalogue, calls the provider and writes the rows. It
// is the second half of `domain/memberProductCatalogue.ts` rather than a
// replacement for it: *which* Products a member may see is still that module's
// one predicate, and this one never re-asks it.
//
// Five of its answers are the rule rather than the implementation.
//
//  - **A purchase is a snapshot beside a link, never instead of it.** The
//    thread's `Q2` asks for `member_products` to "store there a snapshot of
//    what has been purchased while maintaining a link against the original
//    product", which is #635 §16 one table over: what the member was shown and
//    charged is frozen on the row, and `product_id` is where "what is this
//    Product now" is answered. So a Product renamed, repriced, retired or
//    re-rated afterwards moves nothing about a purchase already made, and
//    nothing here reads the live catalogue to describe one.
//  - **Stage 2 buys a one-off, and a recurring Product is absent rather than
//    broken.** `Q3` answers that a one-off is "prompted to pay the one-shot
//    item" while a recurring one means the system "create[s] or update[s] the
//    billing event plan for such member" — a second recurring schedule beside
//    `user_memberships.next_billing_date`, which is a change to what the
//    nightly run charges and not a shop. So a recurring Product reports
//    `recurring_not_supported` and the Members App renders **no Buy action at
//    all** for it (#1073's "a control that cannot work is absent, never
//    broken"), rather than a button that answers an error. Whether a frequency
//    is recurring is `isRecurringFrequency()` (#550) and never a second list:
//    `once`, a legacy `per_session` (#945) and no frequency at all are the
//    one-offs.
//  - **"Available" is the absence of a row.** §6 asks for three states and the
//    column holds two of them, so a Product nobody has bought has no
//    `member_products` row and reads `available`. `cancelled` is where a
//    purchase whose payment failed or expired goes — it is not a state the
//    catalogue reports, because a member who did not end up paying is back to
//    being able to buy.
//  - **Only a pending purchase blocks a second one.** A checkout in flight is
//    the accidental duplicate §6 is about (a double-tapped button, a second
//    tab, a reloaded page), and `mprod_pending_purchase_key` is UNIQUE over it
//    so the route's 409 and the database agree. An `active` purchase does
//    **not** block: nothing in `products` says an item may be bought once (the
//    thread's `Q1` is explicit that the member catalogue is the gym's two
//    existing columns and no new flag), and a second session package months
//    later is a real purchase — refusing it would be this module inventing a
//    rule the product model does not have.
//  - **The money is the server's one figure.** The amount charged is the
//    VAT-inclusive price stage 1 already quotes through `computePriceFields()`
//    (#817: a page does no tax arithmetic), so nothing here re-rates, divides
//    or multiplies it — in particular a Sessions package is charged for the
//    whole package and never per session (#942).

import { isRecurringFrequency } from './productClassification';

/** `payment_requests.source` of a product purchase (migration 228). */
export const PRODUCT_PURCHASE_SOURCE = 'product_purchase';

/** What `member_products.status` may hold, mirrored by `chk_mprod_status`. */
export const MEMBER_PRODUCT_STATUSES = ['pending_payment', 'active', 'cancelled'] as const;
export type MemberProductStatus = (typeof MEMBER_PRODUCT_STATUSES)[number];

/** #799's actor snapshot, mirrored by `chk_mprod_created_by_type`. */
export const PURCHASE_ACTOR_TYPES = ['staff', 'superadmin', 'member'] as const;
export type PurchaseActorType = (typeof PURCHASE_ACTOR_TYPES)[number];

/** The status a purchase is created with: paid for, or it never happened. */
export const PENDING_PURCHASE_STATUS: MemberProductStatus = 'pending_payment';

/** What the member's catalogue reports per Product (§6). */
export type ProductPurchaseState = 'available' | 'pending_payment' | 'purchased';

/**
 * Why a Product cannot be bought right now.
 *
 * `recurring_not_supported` is stage 2's own boundary rather than a
 * configuration error, which is why the Members App renders no action for it
 * instead of an explanation of something it cannot do yet.
 */
export type PurchaseBlock = 'no_price' | 'recurring_not_supported' | 'purchase_pending';

/** The columns a purchase decision needs from a catalogue row. */
export interface PurchasableProduct {
  type: string;
  billing_frequency: string | null;
  /** The VAT-inclusive price the member is quoted; `null` for an unpriced item. */
  price_incl_tax: number | null;
  units?: number | null;
  name?: string;
  currency?: string;
}

/**
 * Whether a purchase may be started for this Product, and why not.
 *
 * `pendingPurchase` is whether this member already has a checkout in flight for
 * it — the one state that blocks, per the note above. The order matters only
 * for the message the route answers with; a Product can be several of these at
 * once.
 */
export function productPurchaseBlock(
  product: PurchasableProduct,
  pendingPurchase = false,
): PurchaseBlock | null {
  if (pendingPurchase) return 'purchase_pending';
  if (isRecurringFrequency(product.billing_frequency)) return 'recurring_not_supported';
  if (product.price_incl_tax == null || !(product.price_incl_tax > 0)) return 'no_price';
  return null;
}

/** Whether a member may start a purchase of this Product. */
export function isPurchasable(product: PurchasableProduct, pendingPurchase = false): boolean {
  return productPurchaseBlock(product, pendingPurchase) === null;
}

/**
 * Which state the catalogue reports for a Product, given this member's own
 * purchases of it.
 *
 * A pending checkout outranks a completed purchase: it is the one that has
 * something outstanding, and it is what the Buy action must not offer again.
 * `cancelled` rows say nothing — a payment that never completed leaves the
 * Product available.
 */
export function purchaseStateFor(
  statuses: readonly (string | null | undefined)[],
): ProductPurchaseState {
  if (statuses.some((s) => s === 'pending_payment')) return 'pending_payment';
  if (statuses.some((s) => s === 'active')) return 'purchased';
  return 'available';
}

/** What the catalogue reports about this member's relationship to a Product. */
export interface ProductPurchaseFields {
  purchase_state: ProductPurchaseState;
  /** Whether the Buy action exists at all for this member (§6, #1073). */
  purchasable: boolean;
}

/**
 * The two fields stage 2 adds to a catalogue row, from this member's own
 * `member_products` statuses for it.
 *
 * It is composed onto `shapeMemberProduct()`'s result rather than folded into
 * it, so `domain/memberProductCatalogue.ts` stays what stage 1 made it: the one
 * answer to *which Products a member may be shown*, with no idea what anybody
 * has bought.
 */
export function describeProductPurchase(
  product: PurchasableProduct,
  statuses: readonly (string | null | undefined)[] = [],
): ProductPurchaseFields {
  const purchase_state = purchaseStateFor(statuses);
  return {
    purchase_state,
    purchasable: isPurchasable(product, purchase_state === 'pending_payment'),
  };
}

/** What a `member_products` row is written with, beside its ids. */
export interface PurchaseSnapshot {
  product_name: string;
  product_type: string;
  billing_frequency: string | null;
  units: number | null;
  amount: number;
  currency: string;
  tax_rate_percent: number | null;
}

/**
 * The snapshot of a Product as it is being bought.
 *
 * `amount` is the figure the member was quoted, VAT included, and
 * `tax_rate_percent` the rate behind it — `null` where the gym has configured
 * none, which is a different fact from 0% and is what keeps a purchase from
 * claiming a tax treatment it never had (#942's `taxNoteKey()` rule, one layer
 * down).
 */
export function purchaseSnapshot(product: {
  name: string;
  type: string;
  billing_frequency: string | null;
  units: number | null;
  price_incl_tax: number | null;
  currency: string;
  tax_rate_percent: number | null;
}): PurchaseSnapshot {
  return {
    product_name: product.name,
    product_type: product.type,
    billing_frequency: product.billing_frequency,
    units: product.units,
    amount: product.price_incl_tax ?? 0,
    currency: product.currency,
    tax_rate_percent: product.tax_rate_percent,
  };
}

/** The 400/409 body a refused purchase answers with. */
export function purchaseBlockResponse(block: PurchaseBlock): { status: number; error: string; message: string } {
  switch (block) {
    case 'purchase_pending':
      return {
        status: 409,
        error: block,
        message: 'This product already has a payment in progress',
      };
    case 'recurring_not_supported':
      return {
        status: 400,
        error: block,
        message: 'A recurring product cannot be purchased from the Members App yet',
      };
    case 'no_price':
      return {
        status: 400,
        error: block,
        message: 'This product has no price to charge',
      };
  }
}
