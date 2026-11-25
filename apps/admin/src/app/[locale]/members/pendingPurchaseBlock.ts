/**
 * #3355 stage 1 — what *+ Add Product* and *+ Add Membership Plan* do while the member holds a
 * Purchase awaiting payment (pure). The fact is the API's (`has_pending_payment_purchase` on the
 * member's configuration read); the API refuses the same requests (`409 purchase_pending_payment`),
 * so this only keeps the workflow from opening onto a refusal and says why, under the button.
 */
export type AddPurchaseAction = 'open' | 'blocked';

export function addPurchaseAction(hasPendingPaymentPurchase: boolean | null | undefined): AddPurchaseAction {
  return hasPendingPaymentPurchase === true ? 'blocked' : 'open';
}

/** The locale key (members namespace) of the red notice shown under a blocked button. */
export const PENDING_PURCHASE_BLOCKED_KEY = 'purchase_pending_payment_blocked';

