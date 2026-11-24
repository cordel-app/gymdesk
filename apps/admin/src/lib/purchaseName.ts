// #3270 / #3288 — a purchase (#3251's cart) as the Admin shows it. Its name is the complete
// canonical string the API generated once when the purchase was created (`purchases.name`, e.g.
// `Gym Name - Compra - 23/11/2026 11:56`): shown verbatim, never re-translated, re-formatted or
// prefixed here, so the purchase, its Billing Event and its payment read as one identity.

export interface PurchaseLike {
  id: number;
  /** The canonical name, shown as stored. */
  name: string;
  status: string;
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
