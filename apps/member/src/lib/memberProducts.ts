// #1121 stage 1 — everything the Members App's **Additional Products and
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
