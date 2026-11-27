/**
 * #3537 — whether the Members App offers **Pay** and **Cancel** on a purchase (#3251's cart,
 * `purchases`) awaiting its payment. Pure; the routes ask it again before acting.
 *
 * Only a standalone checkout of one-time Products qualifies: the purchase is the member's own
 * (they are its owner), it is `pending_payment`, it contracted no plan and holds no recurring
 * Product, and no Product Set is in it. A checkout that carries a Product Set is the cart card's
 * (#2746 stage 3 / #3309: its Cancel returns the version to the cart rather than cancelling it), so
 * it gets neither action here and keeps that one place.
 *
 * Cancelling cancels the **purchase**, through staff's own `cancelPendingPurchase()` (#3355 stage 3):
 * its one payment covers every Product it holds, so one of them cannot be dropped from it without
 * changing what the provider was asked for.
 */
export interface PendingPurchaseFacts {
  status: string;
  ownerMemberId: number;
  planCount: number;
  productKinds: string[];
  hasProductSet: boolean;
}

export function memberMaySettlePendingPurchase(p: PendingPurchaseFacts, memberId: number): boolean {
  return p.status === 'pending_payment'
    && p.ownerMemberId === memberId
    && p.planCount === 0
    && !p.hasProductSet
    && p.productKinds.length > 0
    && p.productKinds.every((k) => k === 'oneoff' || k === 'session');
}
