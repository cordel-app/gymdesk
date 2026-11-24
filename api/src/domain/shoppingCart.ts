/**
 * #2746 — what a member's cart holds, counted from their Draft Product Set's own read: the
 * Membership Plans this Draft adds and the Products it adds (recurring lines the Draft added and
 * the one-time Products linked to it). Plans and lines the member already holds (`inherited`) and
 * a plan carried for entitlement only are not in the cart; a plan's included benefits are not
 * Products (§4). Pure: no I/O.
 */
export interface CartCounts { plans: number; products: number }

export function cartCounts(view: {
  plans: readonly { change: 'added' | 'inherited'; entitlement_only?: boolean }[];
  lines: readonly { change: 'added' | 'inherited' }[];
  purchases: readonly unknown[];
}): CartCounts {
  return {
    plans: view.plans.filter((p) => p.change === 'added' && !p.entitlement_only).length,
    products: view.lines.filter((l) => l.change === 'added').length + view.purchases.length,
  };
}

/**
 * #3305 — a cart staff are still preparing: the owner's purchase (`purchases`, #3251) is In Cart and
 * was created from the Admin App (`purchases.channel = 'admin_app'`, #3278 — written once, from the
 * route, never from a request field). That is the whole rule: what the cart holds (a plan change,
 * standalone Products, both) plays no part. The member may read it but not pay, discard or change
 * it, nor add to it; it reaches the member once staff submit it (Save & Pay → `pending_payment`), and
 * a cart staff discard is gone. A cart the member created stays theirs whatever staff add to it.
 * NULL (a system or legacy purchase) is not staff. Pure.
 */
export function staffPreparesCart(cart: { status: string; channel?: unknown } | null | undefined): boolean {
  return !!cart && cart.status === 'in_cart' && cart.channel === 'admin_app';
}

/**
 * #2895 / #3305 — whether an In Cart Product Set is one staff are still preparing: its cart is
 * staff-created (`staffPreparesCart()` over `cart_channel`, the set's purchase's channel). A Draft
 * linked to an assignment (`productSetAssignmentSql()`: `createDraftSetForAssignment()` / `⋮ → Edit`)
 * also answers yes, as it did under #2895, for a staff Draft that belongs to no staff-created cart
 * (one opened before #3278 recorded a channel, or one added to a cart the member opened): the
 * member's own Draft never links one (#2743, #2496). Pure.
 */
export function awaitsStaffSetup(set: { status: string; linked_user_membership_id?: unknown; cart_channel?: unknown }): boolean {
  if (set.status !== 'in_cart') return false;
  return set.linked_user_membership_id != null || staffPreparesCart({ status: 'in_cart', channel: set.cart_channel });
}

/** The refusal a member's write on such a Draft answers, and the code an add answers while one exists. */
export const AWAITING_STAFF_SETUP = 'awaiting_staff_setup';
