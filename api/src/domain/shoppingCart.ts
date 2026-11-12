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
