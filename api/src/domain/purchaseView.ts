// #3270 — a purchase (#3251's cart) as the screens read it: its id, its persisted name basis and its
// status. The name basis is `purchases.name`, the UTC instant the purchase was created (ISO 8601),
// written once by `createPurchase()` and never derived from the plan, the Product Set or the cart's
// contents on a read. What a person reads — a translated "Purchase" label and that instant in the
// browser's own locale and time zone — is composed by the Admin, so this module formats nothing.

import { PURCHASE_STATUSES, type CartItemStatus } from './purchaseStatus';

export interface PurchaseView {
  id: number;
  /** The creation instant, UTC ISO 8601 (`2026-11-23T11:56:00Z`). */
  name: string;
  status: CartItemStatus;
}

/**
 * The purchase of a row read with `purchase_id`, `purchase_name` and `purchase_status`, or `null`
 * when the row belongs to no purchase (a version that is not a checkout).
 */
export function purchaseView(r: { purchase_id?: unknown; purchase_name?: unknown; purchase_status?: unknown }): PurchaseView | null {
  if (r.purchase_id == null || r.purchase_name == null) return null;
  const status = String(r.purchase_status);
  if (!(PURCHASE_STATUSES as readonly string[]).includes(status)) return null;
  return { id: Number(r.purchase_id), name: String(r.purchase_name), status: status as CartItemStatus };
}
