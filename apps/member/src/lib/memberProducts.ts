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
  /** #1118 §4 — the Promotions still on offer for it, the server's own rule. */
  promotions?: MemberProductPromotion[];
  /** #1118 §13 — the Promotion a live purchase was made under, frozen. */
  applied_promotion?: AppliedMemberProductPromotion | null;
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
 * `payment_requests.source` of a product purchase (migration 228), mirrored
 * here because the Members App has to tell one from a membership fee.
 *
 * `GET /me/payment-requests` keeps **listing** a purchase — it is money, unlike
 * #788's card verification, and the member's payment history is where money
 * goes. What it is not is the *membership fee*, which is what the page's
 * "finish your payment" prompt is about, so the distinction is drawn by
 * `isMembershipFeeRequest()` below rather than by a literal in a page.
 */
export const PRODUCT_PURCHASE_SOURCE = 'product_purchase';

/**
 * Whether a payment request is one of the member's **membership fee** payments
 * — the ones the Pay-now prompt and the consent modal are about.
 */
export function isMembershipFeeRequest(source: string | null | undefined): boolean {
  return source !== PRODUCT_PURCHASE_SOURCE;
}

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
    // #1118 §5 — the Promotion lapsed between the quote and the Buy. The member
    // is told so rather than being charged a price they did not choose.
    case 'promotion_not_applicable': return 'membership.promotion_unavailable_error';
    default: return 'membership.product_purchase_error';
  }
}

/* ── #1118: a Promotion on a Product ───────────────────────────────────────── */

/**
 * One Promotion the gym is currently offering on a Product, as
 * `GET /me/products` reports it.
 *
 * Both prices are the server's — `price_incl_tax` grossed up once and the
 * Promotion's treatment applied by the very function the billing engine uses
 * (#896's `applyLineBenefit()`), so this app never recalculates a discount and
 * cannot quote a figure the purchase would not charge.
 */
export interface MemberProductPromotion {
  promotion_id: number;
  promotion_name: string;
  product_id: number;
  action: string;
  value: number | null;
  /** §6 — the billing cycles it covers, or `null` where it names none. */
  duration_cycles: number | null;
  regular_price_incl_tax: number | null;
  final_price_incl_tax: number | null;
}

/** The snapshot of the Promotion a live purchase was actually made under (§13). */
export interface AppliedMemberProductPromotion {
  id: number;
  promotion_id: number;
  promotion_name: string;
  benefit_action: string;
  benefit_value: number | null;
  duration_cycles: number | null;
  regular_amount: number;
  final_amount: number;
  applied_at: string | null;
}

/**
 * Which locale key says what a Promotion does, and what it interpolates.
 *
 * It is the member-facing counterpart of the admin's `benefitTreatmentLabel()`
 * and not a copy of it — the two apps share no frontend module — so it names
 * keys of this app's own and decides the key *before* `t()` is called, because
 * next-intl prints a missing key verbatim. A treatment outside the vocabulary
 * reads as the Promotion's name alone rather than as the raw column.
 *
 * `waive` is in the map although stage 2 never offers one (a Promotion that
 * prices a Product to nothing is not something to buy — there is no payment to
 * make), because the same key set describes an **applied** Promotion read back
 * from a snapshot, which a later stage may well write.
 */
export function promotionBenefitNote(
  action: string, value: number | null, currency: string, locale: string,
): ProductNote | null {
  switch (action) {
    case 'waive':
      return { key: 'membership.promotion_benefit_waive' };
    case 'percentage_discount':
      return value == null ? null : {
        key: 'membership.promotion_benefit_percentage',
        values: { value: formatPercent(value, locale) },
      };
    case 'fixed_discount':
      return value == null ? null : {
        key: 'membership.promotion_benefit_fixed_discount',
        values: { amount: formatPaymentAmount(value, currency, locale) ?? '' },
      };
    case 'fixed_price':
      return value == null ? null : {
        key: 'membership.promotion_benefit_fixed_price',
        values: { amount: formatPaymentAmount(value, currency, locale) ?? '' },
      };
    default:
      return null;
  }
}

/**
 * The duration caption, or `null` for a Promotion that names no period.
 *
 * §6 asks for it in **billing cycles**, and the thread's `Q5` is explicit that
 * a one-off Product has none to express — so the server answers `null` for
 * every grant that is not Periodic (#1135: only a Periodic grant's quantity is
 * a Duration) and the card simply shows the benefit on its own.
 */
export function promotionDurationNote(durationCycles: number | null): ProductNote | null {
  if (durationCycles == null || durationCycles <= 0) return null;
  return { key: 'membership.promotion_duration_cycles', values: { count: durationCycles } };
}

/** A percentage as the member reads it — `50`, `12.5`, never `50.00`. */
function formatPercent(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
}

/**
 * The price the card shows for a Product, given the Promotion the member has
 * applied in the page (if any).
 *
 * The applied Promotion's own `final_price_incl_tax` is the server's figure, so
 * selecting one *replaces* the price rather than recomputing it here — §5's
 * "the updated Final price is immediately displayed" with no arithmetic in the
 * browser (#817).
 */
export function productFinalPrice(
  product: MemberProduct, applied: MemberProductPromotion | null,
): number | null {
  return applied ? applied.final_price_incl_tax : product.price_incl_tax;
}

/**
 * That same figure, formatted in the **Product's own** currency — never the
 * membership's, which is a different row and may be a different currency.
 */
export function productFinalPriceText(
  product: MemberProduct, applied: MemberProductPromotion | null, locale: string,
): string | null {
  return formatPaymentAmount(productFinalPrice(product, applied), product.currency, locale);
}

/**
 * Whether the card shows the regular price struck through beside the final one.
 *
 * Only where the two actually differ: `€50.00 → €50.00` is a line saying
 * nothing, which is the rule the Payments card's own breakdown already follows.
 */
export function showsRegularProductPrice(
  product: MemberProduct, applied: MemberProductPromotion | null,
): boolean {
  if (!applied) return false;
  return applied.final_price_incl_tax != null
    && product.price_incl_tax != null
    && applied.final_price_incl_tax !== product.price_incl_tax;
}
