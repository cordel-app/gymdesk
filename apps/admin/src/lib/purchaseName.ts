// #3270 — the name a person reads for a purchase (#3251's cart): a translated "Purchase" label and
// the purchase's persisted creation instant (`purchases.name`, UTC ISO 8601) formatted in the
// **browser's** own locale and time zone — deliberately not the gym's (#1246), as the issue asks.
// The API stores the instant only; nothing here derives it from the plan or the cart's contents.

export interface PurchaseLike {
  id: number;
  /** The creation instant, UTC ISO 8601. */
  name: string;
  status: string;
}

/**
 * The creation instant as the browser writes a short date and time (`23/11/2026, 12:56`), or `null`
 * when the stored value is not a usable instant. `locale` defaults to the browser's.
 */
export function formatPurchaseInstant(iso: string | null | undefined, locale?: string, timeZone?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short', timeZone }).format(d);
}

/** The locale key of a purchase status's label (the Product Set's own labels, which the cart shares). */
export function purchaseStatusKey(status: string): string | null {
  switch (status) {
    case 'in_cart': return 'product_set_status_in_cart';
    case 'pending_payment': return 'product_set_status_pending_payment';
    case 'completed': return 'purchase_status_completed';
    case 'cancelled': return 'purchase_status_cancelled';
    default: return null;
  }
}
