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
import { formatGymNumber, type GymFormatSettings } from './gymFormat';

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
  /** #1823 — the Product's picture; `null` when it has none. */
  image_url?: string | null;
  /** #2424 — the 1080 × 1080 master the enlarged preview shows. */
  image_full_url?: string | null;
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
  /**
   * #2496 stage 3 — whether the card offers *Add* (to the member's Draft
   * Product Set) instead of Buy. The server's answer: a recurring Product.
   */
  addable_to_draft?: boolean;
  /** #1118 §4 — the Promotions still on offer for it, the server's own rule. */
  promotions?: MemberProductPromotion[];
  /** #1118 §13 — the Promotion a live purchase was made under, frozen. */
  applied_promotion?: AppliedMemberProductPromotion | null;
  /** #2609 stage 2 — `shared` Products are the family's and take no recipient. */
  sharing_type?: string;
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
export function productPriceText(product: MemberProduct, gym?: GymFormatSettings): string | null {
  return formatPaymentAmount(product.price_incl_tax, product.currency, gym);
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
    // #2609 — the chosen family member is no longer in the family (or the Product became shared).
    case 'assignee_not_in_family':
    case 'assignee_not_allowed':
    case 'assignee_invalid': return 'membership.product_assignee_error';
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
  /** #2424 — the Promotion's own description and pictures; `null` when it has none. */
  description?: string | null;
  image_url?: string | null;
  image_full_url?: string | null;
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
  description?: string | null;
  image_url?: string | null;
  image_full_url?: string | null;
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
  action: string, value: number | null, currency: string, gym?: GymFormatSettings,
): ProductNote | null {
  switch (action) {
    case 'waive':
      return { key: 'membership.promotion_benefit_waive' };
    case 'percentage_discount':
      return value == null ? null : {
        key: 'membership.promotion_benefit_percentage',
        values: { value: formatGymNumber(value, gym, 2) },
      };
    case 'fixed_discount':
      return value == null ? null : {
        key: 'membership.promotion_benefit_fixed_discount',
        values: { amount: formatPaymentAmount(value, currency, gym) ?? '' },
      };
    case 'fixed_price':
      return value == null ? null : {
        key: 'membership.promotion_benefit_fixed_price',
        values: { amount: formatPaymentAmount(value, currency, gym) ?? '' },
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
  product: MemberProduct, applied: MemberProductPromotion | null, gym?: GymFormatSettings,
): string | null {
  return formatPaymentAmount(productFinalPrice(product, applied), product.currency, gym);
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

/* ── #1862 — the member's own purchased Products ─────────────────────────── */

/** One item of `GET /me/purchases`; the server already applied the visibility rule. */
export interface OwnPurchase {
  id: number;
  product_name: string;
  amount: number;
  currency: string;
  billing_frequency: string | null;
  own_state: 'active' | 'pending_payment' | 'cancelled';
  /** 'YYYY-MM-DD', the last valid day; `null` when the purchase has none. */
  end_date: string | null;
  /** A ProductSet line (negative id): paid through Pay now, not `/me/purchases/:id/pay`. */
  source?: 'recurring';
  /** #2609 — the family member it is for (the stored one, else the purchaser). */
  assigned_member_id?: number | null;
  assigned_member_name?: string | null;
}

/** The status word `statusTone()` knows for a purchase state (#983: no tone of our own). */
export function ownPurchaseStatusWord(state: OwnPurchase['own_state']): string {
  return state === 'pending_payment' ? 'pending' : state;
}

/** The locale key naming a purchase state. */
export function ownPurchaseStateKey(state: OwnPurchase['own_state']): string {
  switch (state) {
    case 'pending_payment': return 'membership.product_state_pending';
    case 'cancelled': return 'membership.product_state_cancelled';
    default: return 'membership.product_state_active';
  }
}

/** Pay is offered on exactly the purchases awaiting payment — never hidden or disabled there. */
export function ownPurchaseShowsPay(p: OwnPurchase): boolean {
  return p.own_state === 'pending_payment';
}

/** Whether a purchase is paid through the one-off route or the plan's Pay now. */
export function ownPurchasePayPath(p: OwnPurchase): string {
  return p.source === 'recurring' || p.id < 0 ? '/me/payment-requests' : `/me/purchases/${p.id}/pay`;
}

/* ── #2609 stage 2 — who a Product is for ──────────────────────────────────── */

/** One member of `GET /me/products/assignees`: the caller's family, themself included. */
export interface ProductAssignee {
  member_id: number;
  name: string;
  is_owner: boolean;
}

/**
 * Whether the Buy dialog asks who the Product is for. Only a member in a family
 * (someone besides themself to choose) buying an Individual Product: a member
 * with no family buys for themself and a `shared` Product is the family's, so
 * neither is shown a choice that could only have one answer (#2609 §1, §4).
 */
export function showsAssigneeChoice(product: Pick<MemberProduct, 'sharing_type'>, assignees: readonly ProductAssignee[]): boolean {
  return product.sharing_type !== 'shared' && assignees.length > 1;
}

/**
 * The recipients in the order the dialog offers them: the buyer first (the
 * default, so a member who changes nothing buys for themself as before), then
 * the rest of the family in the server's order.
 */
export function assigneeOptions(assignees: readonly ProductAssignee[], selfId: number | null): ProductAssignee[] {
  const self = assignees.filter((a) => a.member_id === selfId);
  return [...self, ...assignees.filter((a) => a.member_id !== selfId)];
}

/**
 * The `assigned_member_id` the purchase request carries: the chosen member when
 * the dialog asked, nothing otherwise — the server then stores the buyer (or no
 * one, for a shared Product) and judges a named member against the family itself.
 */
export function assigneePayload(
  product: Pick<MemberProduct, 'sharing_type'>,
  assignees: readonly ProductAssignee[],
  selectedId: number | null,
): { assigned_member_id?: number } {
  if (!showsAssigneeChoice(product, assignees) || selectedId == null) return {};
  return { assigned_member_id: selectedId };
}

/**
 * The "For <name>" line of a purchase: shown only to a member in a family, where
 * it says something (to a member with no family every purchase is their own), and
 * only when the server named someone. `null` means no line.
 */
export function ownPurchaseAssigneeName(p: OwnPurchase, assignees: readonly ProductAssignee[]): string | null {
  if (assignees.length <= 1) return null;
  const name = p.assigned_member_name?.trim();
  return name ? name : null;
}

/* ── #2496 stage 3 — Add Product to the member's Draft Product Set ─────────── */

/** One Product line of `GET /me/product-sets/:id`, as this page reads it. */
export interface MemberSetLine {
  id: number;
  product_id: number;
  change: 'added' | 'inherited';
  /** #2663 — the line's frozen snapshot, for *My Products*. */
  product_name?: string;
  description?: string | null;
  image_url?: string | null;
  image_thumbnail_url?: string | null;
  quantity?: number;
  billing_frequency?: string | null;
  currency?: string;
  regular_amount?: number;
  final_amount?: number;
  assigned_member_id?: number | null;
  /** #2781 — the line's own status (`productLineStatus()` in the API), never the version's. */
  status?: string;
  /** #2781 — the last day of a removed line that runs to its end date. */
  ends_at?: string | null;
}

/** The member's current version (Draft, else Active) as `GET /me/product-sets/:id` answers it. */
export interface MemberSetView {
  id: number;
  status: string;
  /** #2496 stage 5 — whose version it is (a family version is read, never cancelled, by a beneficiary). */
  owner_member_id?: number;
  expires_in_seconds?: number | null;
  lines: MemberSetLine[];
  /** #2496 stage 4 — the version's Membership Plans (`added` by this Draft, or `inherited`). */
  plans?: MemberSetPlan[];
}

/** One Membership Plan of `GET /me/product-sets/:id`. */
export interface MemberSetPlan {
  plan_snapshot_id: number;
  membership_plan_id: number | null;
  plan_name: string | null;
  change: 'added' | 'inherited';
  /** #2663 — what *My Plans* draws, all off this version's own plan snapshot. */
  plan_description?: string | null;
  /** #2744 — the Plan's picture and cadence, for the Add Plan catalogue's card. */
  plan_image_url?: string | null;
  plan_image_thumbnail_url?: string | null;
  billing_interval?: number | null;
  billing_unit?: string | null;
  status?: string;
  entitlement_only?: boolean;
  starts_at?: string | null;
  ends_at?: string | null;
  membership_fee?: number | null;
  discount_reason?: string | null;
  beneficiaries?: { member_id: number; name: string | null; is_owner: boolean }[];
  benefits?: { category: string; product_id: number; name: string; quantity: number; billing_frequency: string | null; unit_price: number; mandatory?: boolean; image_url?: string | null; image_thumbnail_url?: string | null }[];
}

/** A row of `GET /me/product-sets`. */
export interface MemberSetRow {
  id: number;
  status: string;
  /** #2663 — the member's own version, as opposed to a family version they are covered by. */
  own?: boolean;
}

/**
 * The statuses a version may be selected in, newest-in-lifecycle first: the
 * member's in-flight Draft, then a version awaiting its first payment, then the
 * Active one. The Admin's Products tab reads the same order (#1463: the
 * in-flight version, else the active one). A superseded version is history and
 * is never selected (#2663 Scenario E: no arbitrary fallback).
 */
export const SELECTABLE_SET_STATUSES = ['draft', 'pending_payment', 'active'] as const;

/**
 * #2663 — the one Product Set the *My Plans* and *My Products* sections both
 * read, resolved once per page load: the member's own version before a family
 * version they are only covered by, and within each the first status of
 * `SELECTABLE_SET_STATUSES` (a newer Draft wins over the Active version, never
 * the other way round). `GET /me/product-sets` already lists only the member's
 * own Draft, so nothing here judges ownership.
 */
export function currentSetId(rows: readonly MemberSetRow[]): number | null {
  const groups = [rows.filter((r) => r.own !== false), rows.filter((r) => r.own === false)];
  for (const group of groups) {
    for (const status of SELECTABLE_SET_STATUSES) {
      const row = group.find((r) => r.status === status);
      if (row) return Number(row.id);
    }
  }
  return null;
}

/**
 * #2781 — the locale key one Product line's status chip reads under: the line's
 * own status, in the `membership.status` map Membership Plans already use, or
 * `null` (no chip) for a response that predates it or a value the map lacks.
 * The Product Set's own status is never shown in the Members App.
 */
const LINE_STATUS_KEYS = ['draft', 'pending_payment', 'cancels_on_end_date', 'pending', 'active'];
export function setLineStatusKey(line: Pick<MemberSetLine, 'status'>): string | null {
  return line.status && LINE_STATUS_KEYS.includes(line.status) ? `membership.status.${line.status}` : null;
}

export function setPlans(view: MemberSetView | null): MemberSetPlan[] {
  return view?.plans ?? [];
}

/**
 * #2744 — which plan card of *My Plans* carries the pending payment, with its
 * *Pay now* and *Cancel*: the first billed plan of the member's **own** version
 * awaiting its first payment. One card only, because the version is paid and
 * cancelled as a whole (one initial Billing Event, one checkout), so naming the
 * same amount on two cards would read as two payments. `null` when the version
 * is not pending, is a family version the member is only covered by (the owner
 * pays, #2123), or holds no billed plan (the Summary then keeps its own notice).
 */
export function pendingPaymentPlanSnapshotId(view: MemberSetView | null, viewerMemberId: number | null): number | null {
  if (!view || view.status !== 'pending_payment') return null;
  if (viewerMemberId == null || view.owner_member_id !== viewerMemberId) return null;
  const plan = setPlans(view).find((p) => !p.entitlement_only);
  return plan ? plan.plan_snapshot_id : null;
}

/**
 * #2744 — the Home page's one pending payment notice: the plan awaiting its
 * first payment (`pending_membership`, whose figure is the initial obligation
 * Save & Pay wrote), else an open membership-fee payment request. Its *Pay now*
 * opens the existing consent and checkout on My Products, so it creates nothing
 * itself. `null` when nothing is pending.
 */
export function homePendingPayment(
  pending: { membership_fee: number | null } | null | undefined,
  requests: { status: string; source?: string | null; amount: string | number; currency?: string | null }[],
): { amount: number; currency: string } | null {
  if (pending?.membership_fee != null && pending.membership_fee > 0) return { amount: pending.membership_fee, currency: 'EUR' };
  const request = requests.find((r) => r.status === 'pending' && isMembershipFeeRequest(r.source));
  if (!request) return null;
  const amount = Number(request.amount);
  return Number.isFinite(amount) ? { amount, currency: request.currency ?? 'EUR' } : null;
}

/** The Products *My Products* lists: the selected version's own lines (#2663 §3). */
export function setProductLines(view: MemberSetView | null): MemberSetLine[] {
  return view?.lines ?? [];
}

/**
 * Where a recurring Product stands against the member's current version:
 *  - `added`: a line the Draft added — the card offers *Remove*;
 *  - `held`: a line the member already has (inherited by the Draft, or on the
 *    Active version) — a pill, no action, since a second line of a running
 *    Product is the Admin's decision, not the member's;
 *  - `none`: not on the version — the card offers *Add*.
 */
export type DraftProductState =
  | { state: 'added'; lineId: number }
  | { state: 'held' }
  | { state: 'none' };

export function draftProductState(product: Pick<MemberProduct, 'id'>, view: MemberSetView | null): DraftProductState {
  if (!view) return { state: 'none' };
  const lines = view.lines.filter((l) => Number(l.product_id) === product.id);
  const added = view.status === 'draft' ? lines.find((l) => l.change === 'added') : undefined;
  if (added) return { state: 'added', lineId: Number(added.id) };
  if (lines.length > 0) return { state: 'held' };
  return { state: 'none' };
}

/** Whether the card offers *Add* at all: the server's flag and nothing already on the version. */
export function showsAddToDraft(product: MemberProduct, view: MemberSetView | null): boolean {
  return product.addable_to_draft === true && draftProductState(product, view).state === 'none';
}

/** The lines and the plan this Draft added (what the selection notice counts); 0 outside a Draft. */
export function draftAddedCount(view: MemberSetView | null): number {
  if (!view || view.status !== 'draft') return 0;
  return view.lines.filter((l) => l.change === 'added').length
    + (view.plans ?? []).filter((p) => p.change === 'added').length;
}

/**
 * #2496 stage 4 — what a plan card offers while the member is building a
 * Draft (the server decides every rule; this only reads the Draft back):
 *  - `added`: this plan is on the Draft — *Remove*;
 *  - `taken`: the Draft already carries another plan (one the member holds, or
 *    one they added) — no action, since a member takes only their first plan;
 *  - `none`: *Add to my selection*;
 *  - `no_draft`: there is no Draft, so the card keeps its own purchase.
 */
export type DraftPlanState =
  | { state: 'added'; planSnapshotId: number }
  | { state: 'taken' }
  | { state: 'none' }
  | { state: 'no_draft' };

export function draftPlanState(planId: number, view: MemberSetView | null): DraftPlanState {
  if (!view || view.status !== 'draft') return { state: 'no_draft' };
  const plans = view.plans ?? [];
  const added = plans.find((p) => p.change === 'added' && Number(p.membership_plan_id) === planId);
  if (added) return { state: 'added', planSnapshotId: Number(added.plan_snapshot_id) };
  if (plans.length > 0) return { state: 'taken' };
  return { state: 'none' };
}

/**
 * Which locale key explains a refused Draft edit. The API answers a code in
 * `error` (`in_flight`, `edit_locked`, `duplicate_submission`, `draft_expired`);
 * anything else falls back to the generic key.
 */
export function draftErrorKey(message: string | null | undefined): string {
  switch (message) {
    case 'family_owner_only': return 'membership.family_owner_only';
    case 'in_flight': return 'membership.draft_error_in_flight';
    case 'edit_locked': return 'membership.draft_error_locked';
    case 'duplicate_submission': return 'membership.draft_error_duplicate';
    case 'draft_expired': return 'membership.draft_error_expired';
    case 'draft_has_plan': return 'membership.draft_error_has_plan';
    case 'plan_change_via_gym':
    case 'plan_not_removable': return 'membership.draft_error_plan_via_gym';
    default: return 'membership.draft_error_generic';
  }
}

/* ── #2496 stage 5 — the Summary and Save & Pay of the member's Draft ─────── */

/** One item of `GET /me/product-sets/:id/review`'s `summary_items` (the Admin's own review). */
export interface MemberSetReviewItem {
  state: 'active' | 'draft' | 'cancelling';
  type: 'plan' | 'product';
  name: string;
  quantity: number | null;
  billing_frequency: string | null;
  regular_price: number | null;
  promotions: string[];
  initial_amount: number | null;
  final_price: number | null;
}

/** One line of the review's `immediate_lines`: what Save & Pay charges today, as the engine priced it. */
export interface MemberSetReviewLine {
  item_name: string | null;
  quantity: number;
  amount: number;
  regular_unit_price: number | null;
  promotion_name: string | null;
  treatment_action: string | null;
  treatment_value: number | null;
  tax_rate_percent: number | null;
  amount_excl_tax: number | null;
}

/** `GET /me/product-sets/:id/review`, as the Summary reads it. */
export interface MemberSetReview {
  product_set_id: number;
  status: string;
  summary_items: MemberSetReviewItem[];
  immediate_lines: MemberSetReviewLine[];
  amount_due: number | null;
  payment_required: boolean;
  tax_total: number | null;
  currency: string;
  error: string | null;
}

/** §8 — *Products Contracted* is what the Draft adds, *Products Cancelled* what it takes away. */
export function reviewSections(review: MemberSetReview | null): { contracted: MemberSetReviewItem[]; cancelled: MemberSetReviewItem[] } {
  const items = review?.summary_items ?? [];
  return {
    contracted: items.filter((i) => i.state === 'draft'),
    cancelled: items.filter((i) => i.state === 'cancelling'),
  };
}

export type SetCommitAction = 'save_and_pay' | 'activate';

/**
 * §9 — which one action commits the Draft, from the server's review alone:
 * *Save & Pay* while something is owed today, the free activation when nothing
 * is, and none at all when the review could not establish the amount, the
 * version is not a Draft, or the Draft changes nothing. The amount is never
 * decided here.
 */
export function setCommitAction(review: MemberSetReview | null): SetCommitAction | null {
  if (!review || review.status !== 'draft' || review.error || review.amount_due == null) return null;
  const { contracted, cancelled } = reviewSections(review);
  if (contracted.length + cancelled.length === 0) return null;
  return review.payment_required ? 'save_and_pay' : 'activate';
}

/** The discount a charge line carries off its regular price (promotion or benefit), or `null` for none. */
export function reviewLineDiscount(line: MemberSetReviewLine): number | null {
  if (line.regular_unit_price == null) return null;
  const off = Math.round((line.regular_unit_price * line.quantity - line.amount) * 100) / 100;
  return off > 0 ? off : null;
}

/**
 * The `membership.frequency` key a Summary item reads under: a Product's own
 * frequency, or a plan cadence spelled `<interval>_<unit>` by the review.
 * `null` for one that names no period (#1135's rule: `/ Once` describes nothing).
 */
export function reviewFrequencyKey(frequency: string | null): string | null {
  if (!frequency) return null;
  const cadence: Record<string, string> = { '1_month': 'month', '4_week': 'four_weeks', '1_week': 'week', '1_year': 'year' };
  const key = cadence[frequency] ?? frequency;
  return ['week', 'four_weeks', 'month', 'year'].includes(key) ? `membership.frequency.${key}` : null;
}

/**
 * Which locale key explains a refused commit or an unusable review. The API
 * answers a code in `error`; a stale screen (`not_committable`,
 * `nothing_to_pay`, `payment_required`) is told to look again.
 */
export function setCommitErrorKey(code: string | null | undefined): string {
  switch (code) {
    case 'draft_expired': return 'membership.draft_error_expired';
    case 'edit_locked': return 'membership.draft_error_locked';
    case 'in_flight': return 'membership.draft_error_in_flight';
    case 'not_committable':
    case 'nothing_to_pay':
    case 'payment_required': return 'membership.summary_error_changed';
    case 'amount_unavailable': return 'membership.summary_error_amount';
    default: return 'membership.summary_error_generic';
  }
}
