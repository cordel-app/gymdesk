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
 * #2895 — a Draft staff created by assigning a Membership Plan (a Draft linked to an assignment,
 * `product_sets.user_membership_id`: `createDraftSetForAssignment()` / `⋮ → Edit`). The member's
 * own Draft never links one (#2743, #2496), so this is the one test of "is this Draft the gym's,
 * still being set up". The member may read it but not pay, discard or change it: it reaches the
 * member only once staff choose **Members App** as its payment method, which is Save & Pay
 * (`pending_payment`), and that is no longer a Draft. Pure.
 */
export function awaitsStaffSetup(set: { status: string; user_membership_id?: unknown }): boolean {
  return set.status === 'draft' && set.user_membership_id != null;
}

/** The refusal a member's write on such a Draft answers, and the code an add answers while one exists. */
export const AWAITING_STAFF_SETUP = 'awaiting_staff_setup';
