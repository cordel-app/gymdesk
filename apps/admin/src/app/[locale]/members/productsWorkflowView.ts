// #1613 — the Products tab's unified workflow, decided without React.
//
// The ProductSet's status, whether a change affects billing and what the
// review's diff contains are the server's (`/product-sets`, `…/review`); this
// module only combines them into the three answers the tab shows: the PS Status
// chip, the billing section's mode and whether the one global Save & Pay is on.
// It prices nothing and never reads the form's dirty state.

import type { ProductSetSummary } from './membershipConfiguration';

/**
 * The `members.ps_status_*` suffix of a ProductSet status, `null` for no
 * ProductSet or a status the build does not know.
 *
 * #2804 — the status is the ProductSet's own and nothing else: an Active set
 * that holds no plan and no Products (everything was cancelled), or only a plan
 * that cancels on its end date, is still Active. This reverses #2264, which
 * read an empty Active set as None.
 */
const PS_STATUSES = ['in_cart', 'pending_payment', 'active', 'superseded'] as const;
export function psStatusKey(current: ProductSetSummary | null): string | null {
  const s = current?.status;
  return s && (PS_STATUSES as readonly string[]).includes(s) ? s : null;
}

/** A one-off purchase waiting for its payment: it will generate an immediate Billing Event. */
export function pendingOneOffCount(purchases: Array<{ status: string }>): number {
  return purchases.filter((p) => p.status === 'pending_payment').length;
}

/**
 * #2965 — the standalone cart: the one-time purchases waiting in the cart that no Product Set
 * carries. The server marks exactly those with `cart_expires_at` (#2962).
 */
export function standaloneCartCount(purchases: Array<{ status: string; cart_expires_at?: string | null }>): number {
  return purchases.filter((p) => p.status === 'in_cart' && p.cart_expires_at != null).length;
}

/** The review answer reduced to what the mode needs. */
export interface ReviewSummary {
  changes: unknown[];
  /** #2860 — the commit charge broken down line by line; its total is `amount_due`. */
  initial_payment?: InitialPaymentLike;
  /** #2860 — what the Draft contracts, for whom and how often; no amounts. */
  contracted_items?: ContractedItemLike[];
  amount_due: number | null;
  /**
   * #3114 stage 3 — the owner's plans this commit reactivates (`to_be_reactivated`) or cancels
   * (`to_be_canceled`). They change no line of the diff and may owe nothing today, yet they are
   * what the cart commits, so they count as changes (`pendingPlanChangeCount()`).
   */
  plans_to_reactivate?: Array<{ user_membership_id: number; plan_name: string | null }>;
  plans_to_cancel?: Array<{ user_membership_id: number; plan_name: string | null }>;
}

/** #3114 stage 3 — how many plans the cart reactivates or cancels. */
export function pendingPlanChangeCount(review: Pick<ReviewSummary, 'plans_to_reactivate' | 'plans_to_cancel'> | null): number {
  return (review?.plans_to_reactivate?.length ?? 0) + (review?.plans_to_cancel?.length ?? 0);
}

/** Whether the Draft's review lists anything to commit: a diff line or a plan reactivated or cancelled. */
function reviewHasChanges(review: ReviewSummary | null): boolean {
  return (review?.changes.length ?? 0) > 0 || pendingPlanChangeCount(review) > 0;
}

/**
 * #3114 stage 3 — the in-flight set's title in the Summary: its own plan, else the plans the cart
 * reactivates (a cart that only reactivates a plan carries no plan of its own, and is not
 * "Products only"). `null` falls back to the Products-only wording.
 */
export function inFlightSetTitle(
  set: { plan_name: string | null }, review: Pick<ReviewSummary, 'plans_to_reactivate'> | null,
): string | null {
  if (set.plan_name) return set.plan_name;
  const names = (review?.plans_to_reactivate ?? []).map((p) => p.plan_name).filter((n): n is string => !!n);
  return names.length > 0 ? names.join(', ') : null;
}

/** #2860 — `initial_payment` of the review (`initialPaymentBreakdown()`), every figure the server's. */
export interface InitialPaymentLike {
  /** #2890 — the lines' totals before discounts. */
  total_before_discounts: number;
  lines: Array<{
    name: string | null; quantity: number; unit_price: number; line_total: number; discount: number;
    promotion_name: string | null; treatment_action: string | null; treatment_value: number | null;
    tax_rate_percent: number | null; tax_amount: number; amount: number;
    /** #2883 — the Pre-paid periods a Membership Fee line covers, and their cadence; `null` elsewhere. */
    prepaid_periods?: number | null; prepaid_cadence?: { interval: number; unit: string } | null;
    /** #2970 — the prorated stretch and the full prepaid periods of a Membership Fee's first charge. */
    fee_split?: {
      prorated: { days: number; period_days: number; start: string; end: string; amount: number };
      prepaid: { periods: number; start: string; end: string; amount: number } | null;
    } | null;
  }>;
  subtotal_excl_tax: number;
  discount_total: number;
  taxes: Array<{ rate_percent: number | null; base: number; tax: number }>;
  tax_total: number;
  total: number | null;
}

export interface ContractedMemberLike { member_id: number; name: string | null }

/** #2860 — one item of `contracted_items` (`contractedItems()`): it carries no amount by design. */
export interface ContractedItemLike {
  kind: 'plan' | 'product';
  name: string;
  period: 'one_off' | 'recurring';
  billing_frequency: string | null;
  cadence: { interval: number; unit: string } | null;
  quantity: number | null;
  /** #3007 stage 4 — the Draft ends this item; shown as deleted with this effective end date. */
  pending_deletion?: { ends_on: string | null } | null;
  /** #3114 stage 3 — the cart reactivates this plan (the same assignment); open-ended once committed. */
  pending_reactivation?: boolean;
  members: ContractedMemberLike[];
  included: Array<{ name: string; billing_frequency: string | null; quantity: number; members: ContractedMemberLike[] }>;
}

/**
 * #3162 — what the cancel-cart confirmation lists: the cart's plan names and Product names, from the
 * review's `contracted_items` (the server's own list of what the In Cart ProductSet contracts), in its
 * order. A section with nothing to list is empty and the dialog omits it.
 */
export function cartCancelContents(review: Pick<ReviewSummary, 'contracted_items'> | null): { plans: string[]; products: string[] } {
  const items = review?.contracted_items ?? [];
  return {
    plans: items.filter((i) => i.kind === 'plan').map((i) => i.name),
    products: items.filter((i) => i.kind === 'product').map((i) => i.name),
  };
}

/**
 * #3162 — the cancel-cart confirmation's opening sentence: it announces the lists under it, or, for a
 * cart with nothing to list, stands alone (no dangling "which includes:").
 */
export function cartCancelIntroKey(contents: { plans: string[]; products: string[] }): 'ps_cancel_intro' | 'ps_cancel_intro_empty' {
  return contents.plans.length + contents.products.length > 0 ? 'ps_cancel_intro' : 'ps_cancel_intro_empty';
}

/** Recurring items (plans first, as the server lists them) apart from one-off ones. */
export function splitContracted(items: ContractedItemLike[]): { recurring: ContractedItemLike[]; oneOff: ContractedItemLike[] } {
  return {
    recurring: items.filter((i) => i.period === 'recurring'),
    oneOff: items.filter((i) => i.period === 'one_off'),
  };
}

/** The members an item is for, joined; `null` when it names none (the whole family). */
export function contractedMembersText(members: ContractedMemberLike[]): string | null {
  const names = members.map((m) => m.name ?? `#${m.member_id}`);
  return names.length > 0 ? names.join(', ') : null;
}

/**
 * What a line's discount is: the Promotion's name, else its own treatment as a
 * locale key (a percentage, or a waiver). `null` when nothing was taken off.
 */
export function discountText(l: InitialPaymentLike['lines'][number]):
  { key: string; values?: Record<string, string | number>; text?: undefined } | { key?: undefined; text: string } | null {
  if (l.discount <= 0) return null;
  if (l.promotion_name) return { text: l.promotion_name };
  if (l.treatment_action === 'waive') return { key: 'checkout_discount_waived' };
  if (l.treatment_action === 'percentage_discount' && l.treatment_value != null) {
    return { key: 'checkout_discount_percent', values: { percent: l.treatment_value } };
  }
  return { key: 'checkout_discount_direct' };
}

/** #2890 — a line a benefit or discount takes all the way down to €0.00. */
export function lineReducedToZero(l: Pick<InitialPaymentLike['lines'][number], 'amount' | 'discount'>): boolean {
  return l.discount > 0 && l.amount === 0;
}

export interface WorkflowInput {
  current: ProductSetSummary | null;
  /** `GET /product-sets/:id/review` of the Draft; `null` until read or when there is no Draft. */
  review: ReviewSummary | null;
  pendingOneOffs: number;
  /** #2965 — `standaloneCartCount()`; absent reads as none. */
  cartPurchases?: number;
}

/** A Draft that has not expired — the cart the standalone purchases are paid with (#2949 stage 5). */
function liveDraft(input: WorkflowInput): boolean {
  return input.current?.status === 'in_cart' && !input.current?.expired;
}

/** Nothing in flight a standalone cart could join: it is paid on its own (`POST …/checkout`). */
function cartAlone(input: WorkflowInput): boolean {
  return (input.cartPurchases ?? 0) > 0 && !liveDraft(input) && input.current?.status !== 'pending_payment';
}

export type BillingMode = 'simulation' | 'events';

/**
 * Simulation while the proposed configuration differs from the committed one
 * (a Draft whose review lists changes), while a version awaits payment, or
 * while a one-off purchase will generate an immediate Billing Event. An empty
 * Draft — opened and never changed — affects nothing and stays on the ledger.
 */
export function billingMode(input: WorkflowInput): BillingMode {
  if (input.pendingOneOffs > 0) return 'simulation';
  const status = input.current?.status;
  if (status === 'pending_payment') return 'simulation';
  if (status === 'in_cart' && !input.current?.expired && reviewHasChanges(input.review)) return 'simulation';
  return 'events';
}

/** The global Save & Pay: on while something supported waits to be saved or paid. */
export function saveAndPayEnabled(input: WorkflowInput & { canWrite: boolean }): boolean {
  if (!input.canWrite) return false;
  return billingMode(input) === 'simulation' || saveAndPayTarget(input) != null;
}

/**
 * Which surface Save & Pay opens. A Draft or a pending version goes through the
 * existing review → save-and-pay flow; a cart of standalone purchases with no
 * Draft is paid together (`cart`, #2965); a pending one-off alone keeps its own
 * payment link, so the action points the operator to the Products card.
 */
export function saveAndPayTarget(input: WorkflowInput): 'review' | 'cart' | 'purchases' | null {
  const status = input.current?.status;
  if (status === 'pending_payment') return 'review';
  // #2965 — a Draft's Save & Pay pays the standalone cart purchases too, so they alone are a reason to open it.
  if (liveDraft(input) && (reviewHasChanges(input.review) || (input.cartPurchases ?? 0) > 0)) return 'review';
  if (cartAlone(input)) return 'cart';
  return input.pendingOneOffs > 0 ? 'purchases' : null;
}

/** Display-only: hide the rows of a simulation whose charge is zero (and the dates left empty). */
export function withoutZeroRows<
  T extends { dates: Array<{ lines: Array<{ actual_charge: number }>; total: number }>; total: number },
>(simulation: T | null, hideZero: boolean): T | null {
  if (!simulation || !hideZero) return simulation;
  const dates = simulation.dates
    .map((d) => ({ ...d, lines: d.lines.filter((l) => Number(l.actual_charge) !== 0) }))
    .filter((d) => d.lines.length > 0);
  return { ...simulation, dates };
}

/**
 * #2747 stage 2 — what Cancel does to the in-flight version, decided once for the
 * Summary's and the Recurring section's buttons. A Draft is discarded
 * (`DELETE /product-sets/:id`, #1881); a version awaiting its first payment is
 * cancelled and kept (`POST /product-sets/:id/cancel`, stage 1), which is not a
 * return to Draft. Anything else offers no Cancel.
 */
export type CancelRequest =
  | { kind: 'discard_draft'; path: string; method: 'DELETE' }
  | { kind: 'cancel_pending'; path: string; method: 'POST' };

export function cancelRequestFor(set: { id: number; status: string } | null | undefined): CancelRequest | null {
  if (!set) return null;
  if (set.status === 'in_cart') return { kind: 'discard_draft', path: `/product-sets/${set.id}`, method: 'DELETE' };
  if (set.status === 'pending_payment') {
    return { kind: 'cancel_pending', path: `/product-sets/${set.id}/cancel`, method: 'POST' };
  }
  return null;
}

/** The `members.*` key explaining a refused cancellation of a pending version (stage 1's 409 codes). */
export function pendingCancelErrorKey(code: string | null | undefined): string {
  switch (code) {
    case 'payment_settled': return 'ps_cancel_pending_error_settled';
    case 'payment_unresolved': return 'ps_cancel_pending_error_unresolved';
    default: return 'ps_cancel_pending_error';
  }
}
