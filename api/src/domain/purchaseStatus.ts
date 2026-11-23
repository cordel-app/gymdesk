/**
 * #3251 — what a cart's status is, from the statuses of what it holds (pure).
 *
 * A cart (`purchases`, migration 465) holds a Product Set version and one-time Product lines. Each
 * maps to one of four cart-item states; a status a cart does not answer for (none today) maps to null
 * and is ignored. The cart's status is the most advanced one still in play: a payment in flight beats
 * an open cart, an open cart beats a finished checkout, and a checkout that completed beats one whose
 * every item was cancelled.
 */
export const PURCHASE_STATUSES = ['in_cart', 'pending_payment', 'completed', 'cancelled'] as const;
export type CartItemStatus = typeof PURCHASE_STATUSES[number];

const SET_STATUS: Record<string, CartItemStatus> = {
  in_cart: 'in_cart',
  pending_payment: 'pending_payment',
  active: 'completed',
  superseded: 'completed',
  cancelled: 'cancelled',
};

const LINE_STATUS: Record<string, CartItemStatus> = {
  in_cart: 'in_cart',
  pending_payment: 'pending_payment',
  active: 'completed',
  cancelled: 'cancelled',
};

export const CART_ITEM_STATUS = {
  set: (status: string): CartItemStatus | null => SET_STATUS[status] ?? null,
  line: (status: string): CartItemStatus | null => LINE_STATUS[status] ?? null,
};

const PRECEDENCE: CartItemStatus[] = ['pending_payment', 'in_cart', 'completed', 'cancelled'];

/** The cart's status from its items' (at least one). */
export function derivePurchaseStatus(items: CartItemStatus[]): CartItemStatus {
  for (const s of PRECEDENCE) if (items.includes(s)) return s;
  throw new Error('derivePurchaseStatus: a cart with no item has no status');
}
