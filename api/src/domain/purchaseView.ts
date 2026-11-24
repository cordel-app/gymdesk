// #3270 — a purchase (#3251's cart) as the screens read it: its id, its persisted name and its
// status. Since #3288 the name is the complete canonical string (`<Gym> - Purchase - 23/11/2026 11:56`,
// `domain/purchaseName.ts`), written once by `createPurchase()` and never derived from the plan, the
// Product Set or the cart's contents on a read. The screens show it verbatim, so this module formats
// nothing.

import { PURCHASE_STATUSES, type CartItemStatus } from './purchaseStatus';

export interface PurchaseView {
  id: number;
  /** The canonical name, shown verbatim (`Gym - Compra - 23/11/2026 11:56`). */
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
