/**
 * #1521 — what the Member card's **Products** card shows for a purchased
 * product, decided without React so the rules are asserted directly.
 *
 * Every value is the purchase's own frozen copy (`GET /members/:id/products`
 * joins neither `products`, `promotions` nor `tax_rates`), so nothing here
 * recalculates a price, a tax or a promotion from the current catalogue, and a
 * value the system never stored is `null` and renders `—` — never a guess.
 *
 * The module resolves no locale key and formats no date or amount; the
 * component does, so the gym's formatter stays the one place those are applied.
 */

import { PRODUCT_TYPES } from '../financials/products/productProfile';

/** The Promotion a purchase was made under, as the API reports the snapshot. */
export interface PurchasedProductPromotion {
  id: number;
  promotion_id: number;
  promotion_name: string;
  benefit_action: string;
  benefit_value: number | null;
  duration_cycles: number | null;
  regular_amount: number;
  final_amount: number;
  applied_at: string | null;
  /** #2624 stage 5 — the Promotion's image as frozen with the application. */
  promotion_image_url?: string | null;
  promotion_image_thumbnail_url?: string | null;
}

/** One purchase, exactly as `GET /members/:id/products` answers it. */
export interface PurchasedProduct {
  id: number;
  product_id: number;
  status: string;
  product_name: string;
  product_type: string;
  billing_frequency: string | null;
  units: number | null;
  /** What was charged for the whole line, VAT included. */
  amount: number;
  currency: string;
  purchased_at: string | null;
  /** #1693 — last valid day (inclusive), cancellation day and derived state. */
  valid_until?: string | null;
  cancelled_on?: string | null;
  validity_state?: string | null;
  created_at: string | null;
  /** #2962 — when a standalone one-time Product in the cart expires (ISO instant); `null` otherwise. */
  cart_expires_at?: string | null;
  created_by: string | null;
  /** #1883 — `members_app` | `admin`; null/absent reads Unknown. */
  origin?: string | null;
  /** The line's price before any Promotion or discount, VAT included (a line total since #3359). */
  regular_amount: number;
  promotion: PurchasedProductPromotion | null;
  /** Every Promotion applied, in the order they were applied (the API's `promotions`). */
  promotions?: PurchasedProductPromotion[];
  /** #1640 — the Admin's direct discount percentage, if one was applied. */
  direct_discount_percent?: number | null;
  /** #1521 — the VAT percentage the purchase was charged under, if stored. */
  tax_rate_percent?: number | null;
  /** #1521 — the purchase's payment request status, if it has one. */
  payment_status?: string | null;
  /** #1521 — the Billing Event the purchase's payment settles, if any. */
  billing_event_id?: number | null;
  /** #3251 stage 3: the cart (`purchases`) the purchase or line was put in; null before carts existed. */
  purchase_id?: number | null;
  /** #1661 — `recurring` for a line of the member's ProductSet (negative `id`). */
  source?: 'one_off' | 'recurring';
  /** #3358 stage 2 — the line's committed end date (`null` = open-ended). */
  ends_at?: string | null;
  /** #3358 stage 2 — whether Cancel Immediately may bring that end date forward to today. */
  can_cancel_immediately?: boolean;
  /** #2856 — the line the member's open Draft carries for this row; `null` when no open Draft carries it. */
  draft_line_id?: number | null;
  /** #2856 — a recurring line's own quantity; since #3359 a one-time purchase's too. */
  quantity?: number;
  /** #3359 — the final price of one unit, VAT included (the API's; never derived here). */
  unit_amount?: number;
  /** #3359 — the base price of one unit, VAT included, before Promotions and discounts. */
  regular_unit_amount?: number;
  /** #2609 — the family member the Product is for (the purchaser when none was chosen). */
  assigned_member_id?: number | null;
  assigned_member_name?: string | null;
  /** #3021 — the Product's configuration as it stands now (`GET /members/:id/products` only). */
  product_description?: string | null;
  product_mandatory?: boolean | null;
  product_one_time_purchase?: boolean | null;
  product_one_per_member?: boolean | null;
  product_sharing_type?: string | null;
  product_notes?: string | null;
  /** #3021 — the Product's image, for the thumbnail in the row and the Product modal. */
  product_image_url?: string | null;
  product_image_thumbnail_url?: string | null;
}

/** #3021 — `true`/`false` → `yes`/`no`; `null` (no Product row to read) → `null`, rendered `—`. */
export function yesNoKey(value: boolean | null | undefined): 'yes' | 'no' | null {
  return value == null ? null : value ? 'yes' : 'no';
}

/** #3021 — the sharing-type locale suffix, `null` for an absent or unknown value (never a missing key). */
export function sharingTypeKey(value: string | null | undefined): 'individual' | 'shared' | null {
  return value === 'individual' || value === 'shared' ? value : null;
}

/** The statuses `payment_requests.status` can hold (chk_payment_requests_status). */
export const PURCHASE_PAYMENT_STATUSES = ['pending', 'completed', 'failed', 'expired'] as const;

/** The date a purchase is listed under: when it was bought, else created. */
export function purchaseDate(item: Pick<PurchasedProduct, 'purchased_at' | 'created_at'>): string | null {
  return item.purchased_at ?? item.created_at ?? null;
}

/** `21` → `21%`, `10.5` → `10.5%`; `null` when the purchase stored no rate. */
export function formatAppliedTax(percent: number | null | undefined): string | null {
  if (percent == null || !Number.isFinite(Number(percent))) return null;
  const n = Number(percent);
  return `${Number.isInteger(n) ? n : Number(n.toFixed(2))}%`;
}

/** `10` → `10%`; `null` when the purchase carries no direct discount. */
export function formatDirectDiscount(percent: number | null | undefined): string | null {
  return formatAppliedTax(percent);
}

/**
 * The locale-key suffix for a payment status, or `null` for a purchase with no
 * payment request (or a value this build does not know, which must not print a
 * missing key verbatim).
 */
export function paymentStatusKey(status: string | null | undefined): string | null {
  return status && (PURCHASE_PAYMENT_STATUSES as readonly string[]).includes(status) ? status : null;
}

/** Whether *View billing event* has an event to open. */
export function hasBillingEvent(item: Pick<PurchasedProduct, 'billing_event_id'>): boolean {
  return item.billing_event_id != null && Number(item.billing_event_id) > 0;
}

/**
 * The Billing Events page, opened on this purchase's own event. `null` when the
 * purchase has none — the caller then disables the action and says why.
 */
export function billingEventPath(locale: string, item: Pick<PurchasedProduct, 'billing_event_id'>): string | null {
  return hasBillingEvent(item)
    ? `/${locale}/payments/billing-events?id=${Number(item.billing_event_id)}`
    : null;
}

/* ── #1521 stage 2: the Add Product form ─────────────────────────────────── */

/** One Product the staff selector offers, as `GET …/product-purchases/catalogue` answers it. */
export interface PurchasableProductOption {
  id: number;
  name: string;
  type: string;
  billing_frequency: string | null;
  currency: string;
  price_incl_tax: number | null;
  tax_included: boolean;
  tax_rate_percent?: number | null;
  recurring: boolean;
  /**
   * #2854 — the Product's own stored thumbnail (`image_thumbnail_url`, else
   * `image_url`, chosen server-side by `shapeMemberProduct()`); null when none.
   */
  image_url?: string | null;
  promotions: PurchasableProductPromotion[];
  /** #1655 — hidden only by the new-members-only rule; explanatory, never applicable. */
  unavailable_promotions?: { promotion_id: number; promotion_name: string; reason: 'new_members_only' }[];
  /** #2609 — `shared` takes no assigned family member. */
  sharing_type?: string | null;
}

/**
 * #2783 — whether the Product being added shows its nested Promotions block:
 * only when it has a Promotion to offer, or one it would offer a new member
 * (the hint that says why it is not offered). Otherwise no empty block is drawn.
 */
export function hasPromotionBlock(product: {
  promotions?: readonly unknown[] | null;
  unavailable_promotions?: readonly unknown[] | null;
} | null): boolean {
  if (!product) return false;
  return (product.promotions?.length ?? 0) > 0 || (product.unavailable_promotions?.length ?? 0) > 0;
}

/** #2609 — a family member a Product bought for this member may be assigned to. */
export interface EligibleAssignee {
  member_id: number;
  name: string;
  is_owner: boolean;
}

/**
 * #2609 — whether the Add Product form offers an *Assigned to* selector: only when
 * the member belongs to a family (two or more eligible members) and the chosen
 * Product is not shared. With no family the purchase is the member's own and the
 * selector would ask a question with one answer.
 */
export function showsAssigneeSelector(assignees: readonly EligibleAssignee[] | null, product: { sharing_type?: string | null } | null): boolean {
  return !!product && (assignees?.length ?? 0) > 1 && product.sharing_type !== 'shared';
}

export interface PurchasableProductPromotion {
  promotion_id: number;
  promotion_name: string;
  action: string;
  value: number | null;
  duration_cycles: number | null;
  stackable: boolean;
  /** #3020: the Promotion's own image, never the Product's. */
  promotion_image_url?: string | null;
  promotion_image_thumbnail_url?: string | null;
}

/** #3236: a chosen Promotion that makes a Product required, with what its detail modal shows. */
export interface RequiringPromotion {
  id: number; name: string; description: string | null; image_url: string | null; image_thumbnail_url: string | null;
}

/** #2374/#3236: a mandatory Product still to be added, and the Promotions that require it. */
export interface RequiredProduct {
  id: number; name: string; description?: string | null;
  image_url?: string | null; image_thumbnail_url?: string | null;
  required_by?: RequiringPromotion[];
}

/** #3236: the Promotions that triggered the confirmation, each once, in the order the server listed them. */
export function requiringPromotions(products: readonly RequiredProduct[]): RequiringPromotion[] {
  const out = new Map<number, RequiringPromotion>();
  for (const p of products) for (const promo of p.required_by ?? []) if (!out.has(promo.id)) out.set(promo.id, promo);
  return [...out.values()];
}

/** The server's quote (`POST …/product-purchases/quote`): every figure VAT-inclusive. */
export interface PurchaseQuote {
  /** #2374: mandatory Products of the chosen Promotions still to be added (never optional ones). */
  required_products?: RequiredProduct[];
  product_id: number;
  product_name: string;
  recurring: boolean;
  currency: string;
  list_price: number;
  promotions: Array<{
    promotion_id: number; promotion_name: string; regular_amount: number; final_amount: number;
  }>;
  after_promotions: number;
  direct_discount_percent: number | null;
  direct_discount_amount: number | null;
  final_price: number;
  /** #1656 — the server's VAT breakdown of the final price; null with no tax rate. */
  tax_rate_percent?: number | null;
  tax_amount?: number | null;
}

/** The error codes the purchase routes answer with, each with a locale key suffix. */
const PURCHASE_ERROR_CODES = [
  'promotions_not_stackable', 'promotion_not_applicable', 'invalid_direct_discount',
  'final_price_not_positive', 'purchase_pending', 'edit_locked',
  'duplicate_submission', 'in_flight', 'direct_discount_not_allowed', 'duplicate_promotion',
  'nothing_to_pay', 'draft_expired',
  'assignee_not_in_family', 'assignee_not_allowed', 'assignee_invalid',
  'promotion_requires_products',
] as const;

/** The locale-key suffix for an answered error code; `null` falls back to the generic message. */
export function purchaseErrorKey(code: string | null | undefined): string | null {
  return code && (PURCHASE_ERROR_CODES as readonly string[]).includes(code) ? code : null;
}

/** A percentage typed in the form → what is sent: `null` for empty, `NaN`-safe. */
export function parseDiscountInput(raw: string): number | null {
  const trimmed = raw.trim().replace(',', '.');
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : Number.NaN;
}

/**
 * The part of a version's forecast that belongs to one Product: dates keep only
 * that Product's lines and their total is the sum of the server's own charges.
 * Presentation only — no date, amount or benefit is derived here.
 */
export function forecastForProduct<
  T extends { dates: Array<{ date: string; lines: Array<{ product_id: number | null; actual_charge: number }>; total: number }>; total: number },
>(forecast: T | null, productId: number): T | null {
  if (!forecast) return forecast;
  const dates = forecast.dates
    .map((d) => {
      const lines = d.lines.filter((l) => l.product_id === productId);
      return { ...d, lines, total: Math.round(lines.reduce((s, l) => s + l.actual_charge, 0) * 100) / 100 };
    })
    .filter((d) => d.lines.length > 0);
  return {
    ...forecast,
    dates,
    total: Math.round(dates.reduce((s, d) => s + d.total, 0) * 100) / 100,
  };
}

/** #1654 — the Products card's status filter; `''` is "All". */
export const PURCHASE_STATUS_FILTER_DEFAULT = 'open';
export const PURCHASE_STATUS_FILTER_VALUES = ['open', 'in_cart', 'active', 'pending_payment', 'cancelled'] as const;

/**
 * #3358 stage 2 — the statuses the default `open` filter shows: In Cart (#1657, #2949), Active,
 * Pending payment, and the two cancellation states that still grant the Product
 * (`to_be_canceled` / `to_be_canceled_immediately` awaiting Save & Pay, `active_cancel_at_period_end`
 * entitled until its End Date). `cancelled` is not open.
 */
export const OPEN_PURCHASE_STATUSES: string[] = [
  'in_cart', 'active', 'pending_payment',
  'to_be_canceled', 'to_be_canceled_immediately', 'active_cancel_at_period_end',
];

/**
 * Which purchases a filter value shows. The default, `open`, is In Cart (#1657, #2949: a saved
 * one-time purchase stays in the list), Active plus Pending payment (a purchase not yet paid is the pre-active state a Draft is
 * for a recurring Product); `''` shows every status. Presentation only — the
 * status is the purchase's own stored value.
 */
export function filterPurchasesByStatus<T extends { status: string }>(items: T[], filter: string): T[] {
  if (filter === '') return items;
  if (filter === PURCHASE_STATUS_FILTER_DEFAULT) {
    // #3358 stage 2 — a line the cart cancels and one cancelling at its End Date are still live work.
    return items.filter((i) => OPEN_PURCHASE_STATUSES.includes(i.status));
  }
  return items.filter((i) => i.status === filter);
}

/**
 * #3161 — the table's row order: oldest first (`created_at`, then id), so a Product added inline
 * (whose draft row is drawn last) is still the last row once it is saved and the list refreshes,
 * and the other rows keep their order. The API lists newest first (the Members App reads it too),
 * so the order is the table's own and never re-sorted per section. A row with no `created_at`
 * sorts first. Stable: equal keys keep the order they came in.
 */
export function orderPurchasesForTable<T extends { id: number; created_at: string | null }>(items: T[]): T[] {
  const time = (v: string | null) => {
    const ms = v == null ? NaN : Date.parse(v);
    return Number.isNaN(ms) ? -Infinity : ms;
  };
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (time(a.item.created_at) - time(b.item.created_at)) || (a.item.id - b.item.id) || (a.index - b.index))
    .map(({ item }) => item);
}

/**
 * #2856 — the Draft line a row's `⋮ → Edit` / `⋮ → Delete` act on: a recurring
 * row the member's open Draft Product Set carries. Every other row (a committed
 * line with no open Draft, a line the Draft removed, a one-time purchase) gets
 * neither action, so a committed version is never edited from here.
 */
export function editableDraftLineId(item: Pick<PurchasedProduct, 'source' | 'draft_line_id'>): number | null {
  if (item.source !== 'recurring') return null;
  return item.draft_line_id ?? null;
}

/**
 * #2962 — what a cart countdown shows `nowMs` against the server's `cart_expires_at` (#3274: the
 * cart's one clock, its purchase's `expires_at`): the time
 * left as `H:MM:SS` (never negative), and whether it has run out. `null` for a purchase the server
 * gave no expiry (anything but a standalone cart purchase). Presentation only: the expiry instant
 * is the server's, and the server is what deletes the purchase.
 */
export function cartCountdown(
  expiresAt: string | null | undefined,
  nowMs: number,
): { remainingMs: number; expired: boolean; label: string } | null {
  if (!expiresAt) return null;
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return null;
  const remainingMs = Math.max(0, at - nowMs);
  const total = Math.ceil(remainingMs / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const label = `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return { remainingMs, expired: remainingMs === 0, label };
}

/** #2962 — the server's refusal to pay for a cart purchase that has expired. */
export function isPurchaseExpiredError(err: any): boolean {
  return err?.status === 410 && err?.body?.error === 'purchase_expired';
}

/**
 * #3190 — the `products` locale key a purchase's frozen Product Type reads
 * under (`type_fee`, `type_sessions`, …), or `null` for a value outside the
 * Products page's own set, which then reads `—` rather than printing a key
 * (next-intl prints a missing key verbatim).
 */
export function productTypeLabelKey(type: string | null | undefined): string | null {
  return type && (PRODUCT_TYPES as readonly string[]).includes(type) ? `type_${type}` : null;
}

/**
 * #3189 — what a purchase's End date cell reads: its last valid day (or, for
 * a cancelled purchase with no defined validity, the day it was cancelled,
 * #1693) as a date; with neither, `open_ended` — except for a Merchandise
 * Product, which has no lifecycle to be open-ended and reads `dash`.
 * Display only: no date is changed or derived.
 */
export function purchaseEndDisplay(
  item: Pick<PurchasedProduct, 'product_type' | 'valid_until' | 'cancelled_on'>,
): { kind: 'date'; value: string } | { kind: 'open_ended' } | { kind: 'dash' } {
  if (item.product_type === 'merchandise') return { kind: 'dash' };
  const end = item.valid_until ?? item.cancelled_on ?? null;
  return end ? { kind: 'date', value: end } : { kind: 'open_ended' };
}

/**
 * #3359 — what a price cell of the Products table shows: the line total as the main value and,
 * for a quantity above 1, the `quantity × unit` breakdown under it. Both figures are the API's
 * (`regular_amount` / `regular_unit_amount` for the base price, `amount` / `unit_amount` for the
 * final one); nothing is multiplied or divided here, and a row with no unit figure shows no breakdown.
 */
export function purchasePriceCell(
  item: Pick<PurchasedProduct, 'amount' | 'regular_amount' | 'quantity' | 'unit_amount' | 'regular_unit_amount'>,
  which: 'base' | 'final',
): { total: number; breakdown: { quantity: number; unit: number } | null } {
  const total = which === 'base' ? item.regular_amount : item.amount;
  const unit = which === 'base' ? item.regular_unit_amount : item.unit_amount;
  const quantity = item.quantity ?? 1;
  const breakdown = quantity > 1 && unit != null && Number.isFinite(Number(unit))
    ? { quantity, unit: Number(unit) }
    : null;
  return { total, breakdown };
}
