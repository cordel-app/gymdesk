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
  /** What was charged, VAT included. */
  amount: number;
  currency: string;
  purchased_at: string | null;
  created_at: string | null;
  created_by: string | null;
  /** The price before the Promotion, VAT included. */
  regular_amount: number;
  promotion: PurchasedProductPromotion | null;
  /** #1640 — the Admin's direct discount percentage, if one was applied. */
  direct_discount_percent?: number | null;
  /** #1521 — the VAT percentage the purchase was charged under, if stored. */
  tax_rate_percent?: number | null;
  /** #1521 — the purchase's payment request status, if it has one. */
  payment_status?: string | null;
  /** #1521 — the Billing Event the purchase's payment settles, if any. */
  billing_event_id?: number | null;
  /** #1661 — `recurring` for a line of the member's ProductSet (negative `id`). */
  source?: 'one_off' | 'recurring';
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
  promotions: PurchasableProductPromotion[];
}

export interface PurchasableProductPromotion {
  promotion_id: number;
  promotion_name: string;
  action: string;
  value: number | null;
  duration_cycles: number | null;
  stackable: boolean;
}

/** The server's quote (`POST …/product-purchases/quote`): every figure VAT-inclusive. */
export interface PurchaseQuote {
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
  'final_price_not_positive', 'already_owned', 'purchase_pending', 'edit_locked',
  'recurring_line_conflict', 'in_flight', 'direct_discount_not_allowed', 'duplicate_promotion',
  'nothing_to_pay', 'draft_expired',
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
