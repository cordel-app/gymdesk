// #1121 stages 1 and 2 — everything the Members App's **Additional Products and
// Services** subsection decides or formats, and nothing it draws.
//
// The split is `memberPayments.ts`' (#1123) and `NutritionItemRow`'s (#932):
// this module answers which locale **key** a line reads under and how a figure
// is written, `components/MemberProductsSection.tsx` is the look, and the page
// resolves the keys — so nothing here calls `t()` and both halves stay
// assertable (`api/src/test/member-products.unit.test.ts`, in the API suite
// because CI runs `npm test` in `api/` only).
//
// Four of its answers are the rule rather than the implementation.
//
//  - **Nothing here computes money.** `price_incl_tax` is the server's one
//    gross-up (`computePriceFields()`, #817: a page does no tax arithmetic), so
//    this module formats it and never divides, multiplies or re-rates it. In
//    particular a Sessions package is **not** divided by its units: #942 is
//    explicit that `amount` is the price of the whole package, so `units` is
//    here to be *said* and never to be a denominator.
//  - **A frequency reads from the one map.** `membership.frequency` is the
//    Members App's half of #1128's single vocabulary, asserted against the
//    admin's `billing_frequency` namespace, so this module names that key and
//    adds no second spelling of *Monthly*.
//  - **A frequency that names no period gets no suffix.** `once` and a legacy
//    `per_session` (#945) are real stored values with real labels, but `€50 /
//    Once` describes nothing — so the price stands alone, which is #1135's rule
//    for `billingFrequencyDurationLabel()` answering `null`, one app over.
//  - **A missing value is `null`, never a guess.** An unpriced Product reads
//    `—` rather than €0.00 (they are different facts), an item with no tax rate
//    makes no claim about tax, and an unknown frequency falls through to no
//    suffix rather than printing the key — next-intl prints a missing key
//    verbatim, so the decision is taken before `t()` is called.

import { formatPaymentAmount } from './memberPayments';

/** The three states §6 asks the member to be able to tell apart. */
export type ProductPurchaseState = 'available' | 'pending_payment' | 'purchased';

/** The wire shape of one item of `GET /me/products`. */
export interface MemberProduct {
  id: number;
  name: string;
  description: string | null;
  type: string;
  /** The sessions a Sessions package contains; `null` for every other type. */
  units: number | null;
  billing_frequency: string | null;
  price_incl_tax: number | null;
  currency: string;
  tax_included: boolean;
  /** #1121 stage 2 — what this member has done about this Product (§6). */
  purchase_state: ProductPurchaseState;
  /**
   * Whether the Buy action exists for this member. The server's answer, never
   * derived here: a recurring Product and an unpriced one are both
   * unpurchasable in stage 2, and a page deciding that for itself would offer a
   * button the route refuses (or hide one it would have accepted).
   */
  purchasable: boolean;
}

/** A locale key plus whatever it interpolates, for the page to resolve. */
export interface ProductNote {
  key: string;
  values?: Record<string, string | number>;
}

/**
 * The frequencies that name a recurring period, and therefore read beside a
 * price (`€15 / Monthly`).
 *
 * `once` and `per_session` are deliberately absent: both are stored, both have
 * a label in the shared map, and neither answers "how often does this charge
 * repeat".
 */
const RECURRING_FREQUENCIES = ['week', 'four_weeks', 'month', 'year'] as const;

/**
 * Which key names this Product's billing frequency — `membership.frequency.…`,
 * the one map (#1128) — or `null` where the price stands on its own.
 */
export function productFrequencyKey(product: MemberProduct): string | null {
  const value = product.billing_frequency;
  if (!value) return null;
  if (!(RECURRING_FREQUENCIES as readonly string[]).includes(value)) return null;
  return `membership.frequency.${value}`;
}

/** The price as the member reads it, or `null` for a Product carrying none. */
export function productPriceText(product: MemberProduct, locale: string): string | null {
  return formatPaymentAmount(product.price_incl_tax, product.currency, locale);
}

/**
 * The sentence that says a Sessions package's price covers the whole package
 * (#942), or `null` for every other type.
 *
 * It is the member-facing counterpart of the admin's `sessionPackageNote()` and
 * not a copy of it — the two apps share no frontend module — so it names keys of
 * this app's own and keeps the same rule: a package whose `units` is unset says
 * so without inventing a count.
 */
export function productPackageNote(product: MemberProduct): ProductNote | null {
  if (product.type !== 'sessions') return null;
  if (product.units == null) return { key: 'membership.product_package_price' };
  return { key: 'membership.product_sessions_price', values: { count: product.units } };
}

/**
 * Whether the quoted price is tax-inclusive, as a key — `null` where the gym
 * has configured no tax rate for the item, because a claim about tax is not
 * made where there is no rate behind it.
 */
export function productTaxNoteKey(product: MemberProduct): string | null {
  return product.tax_included ? 'membership.product_tax_included' : null;
}

/* ── #1121 stage 2: buying one ─────────────────────────────────────────────── */

/**
 * Which **status word** a purchase state reads as, for `statusTone()`.
 *
 * The tone map is `memberChrome.ts`' one answer for the whole app (#983), so
 * this module names a status it already knows rather than a colour or a tone of
 * its own: a purchase waiting for its payment is `pending` (warning) and a
 * completed one is `active` (success), exactly as a membership in those states.
 * `available` has no pill at all — there is nothing to report about a Product
 * the member has not touched.
 */
export function purchaseStateStatusWord(state: ProductPurchaseState): string | null {
  if (state === 'pending_payment') return 'pending';
  if (state === 'purchased') return 'active';
  return null;
}

/** Which locale key names a purchase state, or `null` where none is shown. */
export function purchaseStateKey(state: ProductPurchaseState): string | null {
  if (state === 'pending_payment') return 'membership.product_state_pending';
  if (state === 'purchased') return 'membership.product_state_purchased';
  return null;
}

/**
 * Whether the Buy action is rendered for this Product.
 *
 * It is the server's `purchasable` and nothing else. In particular a recurring
 * Product renders **no action at all** rather than a disabled button or an
 * explanation: stage 2 buys a one-off (the thread's `Q3`), and #1073's rule is
 * that a control which cannot work is absent, never broken.
 */
export function showsBuyAction(product: MemberProduct): boolean {
  return product.purchasable && product.purchase_state === 'available';
}

/**
 * Which locale key explains a refused purchase.
 *
 * The API answers the refusal **code** in `error` (`purchase_pending`,
 * `recurring_not_supported`, `no_price`), so the member reads it in their own
 * language rather than the route's English. An unrecognised message — a 500, a
 * network failure, a rate limit — falls back to the generic key, decided here
 * before `t()` is called because next-intl prints a missing key verbatim.
 */
export function purchaseErrorKey(message: string | null | undefined): string {
  switch (message) {
    case 'purchase_pending': return 'membership.product_purchase_pending_error';
    case 'recurring_not_supported': return 'membership.product_purchase_recurring_error';
    case 'no_price': return 'membership.product_purchase_unpriced_error';
    default: return 'membership.product_purchase_error';
  }
}
