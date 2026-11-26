// #3443 — the **Purchases** tab of My Products: the member's own purchases
// (`GET /me/purchase-history`), newest first, a page at a time.
//
// Pure: the request, how a page joins the list, and which locale **key** each
// status reads under. It resolves no `t()` and computes no money: the total,
// the items and every status are the API's, read from what the purchase
// persisted. Three statuses stay three: the purchase's own lifecycle, each
// Billing Event's status and its payment attempt's status are never folded
// into one another.

export const PURCHASE_HISTORY_PATH = '/me/purchase-history';
export const PURCHASE_HISTORY_PAGE_SIZE = 10;

export interface PurchaseHistoryMember { id: number; name: string | null }

export interface PurchaseHistoryItem {
  id: number;
  name: string | null;
  status: string;
  created_at: string;
  total_amount: string | null;
  owner: PurchaseHistoryMember;
  plans: Array<{
    name: string | null;
    status: string;
    starts_at: string | null;
    beneficiaries: PurchaseHistoryMember[];
    products: Array<{ name: string | null; quantity: number; beneficiary: PurchaseHistoryMember | null }>;
  }>;
  products: Array<{
    kind: string;
    name: string | null;
    billing_frequency: string | null;
    quantity: number;
    beneficiary: PurchaseHistoryMember | null;
  }>;
  billing_events: Array<{
    id: number;
    name: string | null;
    amount: string | null;
    status: string | null;
    payment_status: string | null;
    payment_method_name: string | null;
    paid_at: string | null;
    created_at: string;
  }>;
}

export interface PurchaseHistoryPage {
  items: PurchaseHistoryItem[];
  total: number;
  limit: number;
  offset: number;
}

/** The request for the page starting at `offset`. */
export function purchaseHistoryPath(offset: number, limit = PURCHASE_HISTORY_PAGE_SIZE): string {
  return `${PURCHASE_HISTORY_PATH}?limit=${limit}&offset=${Math.max(0, Math.trunc(offset))}`;
}

/** A page joined to what is shown: a purchase already listed is never listed twice. */
export function appendPurchasePage(shown: PurchaseHistoryItem[], page: PurchaseHistoryItem[]): PurchaseHistoryItem[] {
  const seen = new Set(shown.map((p) => p.id));
  return [...shown, ...page.filter((p) => !seen.has(p.id))];
}

/** Whether another page exists after `shownCount` of `total`. */
export function hasMorePurchases(shownCount: number, total: number): boolean {
  return shownCount < total;
}

const PURCHASE_STATUSES = new Set(['in_cart', 'pending_payment', 'completed', 'cancelled']);
const EVENT_STATUSES = new Set([
  'paid', 'failed', 'pending', 'scheduled', 'waived', 'cancelled', 'expired_24h', 'refunded', 'partially_refunded',
]);
const PAYMENT_STATUSES = new Set([
  'completed', 'pending', 'failed', 'expired', 'canceled', 'refunded', 'partially_refunded',
]);

/** The purchase's own lifecycle; `null` for a value this app has no wording for (never the raw key). */
export function purchaseStatusKey(status: string | null | undefined): string | null {
  return status && PURCHASE_STATUSES.has(status) ? `purchases.status.${status}` : null;
}

/** A Billing Event's status, as the Payments tab reads it. */
export function purchaseEventStatusKey(status: string | null | undefined): string | null {
  return status && EVENT_STATUSES.has(status) ? `purchases.event_status.${status}` : null;
}

/** The payment attempt's (provider's, normalized) status. */
export function purchasePaymentStatusKey(status: string | null | undefined): string | null {
  return status && PAYMENT_STATUSES.has(status) ? `purchases.payment_status.${status}` : null;
}

/** The tone a status pill takes, from the shared `statusTone()` vocabulary. */
export function purchaseStatusToneValue(status: string): string {
  switch (status) {
    case 'completed': return 'completed';
    case 'pending_payment': return 'pending';
    case 'cancelled': return 'cancelled';
    default: return status; // in_cart → neutral
  }
}

/** How many items a purchase holds, plan lines and standalone Products together (for the summary). */
export function purchaseItemCount(p: PurchaseHistoryItem): number {
  return p.plans.length + p.products.length;
}

/** The persisted total as a number, `null` when the purchase has no Billing Event yet. */
export function purchaseTotal(p: PurchaseHistoryItem): number | null {
  if (p.total_amount == null) return null;
  const n = Number(p.total_amount);
  return Number.isFinite(n) ? n : null;
}

/** The beneficiary note of an item: only when it is for somebody other than the buyer. */
export function beneficiaryName(
  beneficiary: PurchaseHistoryMember | null | undefined, ownerId: number,
): string | null {
  if (!beneficiary || beneficiary.id === ownerId || !beneficiary.name) return null;
  return beneficiary.name;
}
