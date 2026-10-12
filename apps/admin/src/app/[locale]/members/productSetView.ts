// #1463 — the Products tab's ProductSet presentation, as pure decisions.
//
// Nothing here prices, charges or decides lifecycle: the version's status, its
// configuration and its forecast are the server's (`/product-sets`). This only
// names a version, and splits the Products its configuration carries into the
// two groups the tab shows, so both are assertable without a component harness.

import type { ProductSetSummary } from './membershipConfiguration';

/** A frozen Membership Plan benefit line or an Additional Periodic Service, as `GET /product-sets/:id` reports it. */
export interface ProductSetConfigurationLike {
  planBenefits?: Array<{
    productId: number; name: string; category: string; quantity: number; unitPrice: number;
    billingFrequency: string | null;
  }>;
  services?: Array<{
    id: number; productId: number; name: string; quantity: number; unitPrice: number;
    billingFrequency: string | null; startsOn: string; endsOn: string | null;
  }>;
}

export interface ProductSetProductLine {
  key: string;
  name: string;
  quantity: number;
  unitPrice: number;
  billingFrequency: string | null;
}

export interface ProductSetProducts {
  oneOff: ProductSetProductLine[];
  recurring: ProductSetProductLine[];
}

/**
 * The derived label of a version: `<Plan name> — v<version>`, or the caller's
 * resolved "Products only" wording for a version that carries no plan. There is
 * no stored name (#1463's default), so every surface composes it here.
 */
export function productSetName(
  set: Pick<ProductSetSummary, 'plan_name' | 'version'>,
  noPlanLabel: string,
): string {
  return `${set.plan_name ?? noPlanLabel} — v${set.version}`;
}

/** The `members` locale key of a status badge; unknown statuses read as the raw value's own key-less fallback (`null`). */
export function productSetStatusKey(status: string, expired: boolean): string | null {
  if (status === 'draft' && expired) return 'product_set_status_expired';
  switch (status) {
    case 'draft': return 'product_set_status_draft';
    case 'pending_payment': return 'product_set_status_pending_payment';
    case 'active': return 'product_set_status_active';
    case 'superseded': return 'product_set_status_superseded';
    default: return null;
  }
}

/**
 * One-off Products are the version's One-off and Session benefit lines (a
 * Sessions package is bought once); Recurring Products are its Period benefit
 * lines and the Additional Periodic Services attached to it.
 */
export function splitProductSetProducts(config: ProductSetConfigurationLike | null | undefined): ProductSetProducts {
  const oneOff: ProductSetProductLine[] = [];
  const recurring: ProductSetProductLine[] = [];
  for (const b of config?.planBenefits ?? []) {
    const line = {
      key: `${b.category}-${b.productId}`,
      name: b.name, quantity: b.quantity, unitPrice: b.unitPrice, billingFrequency: b.billingFrequency,
    };
    (b.category === 'periodical' ? recurring : oneOff).push(line);
  }
  for (const s of config?.services ?? []) {
    recurring.push({
      key: `service-${s.id}`,
      name: s.name, quantity: s.quantity, unitPrice: s.unitPrice, billingFrequency: s.billingFrequency,
    });
  }
  return { oneOff, recurring };
}

/** #1490 — every Product the version carries (One-off and Recurring), counted from the lines themselves. */
export function productSetProductCount(products: ProductSetProducts): number {
  return products.oneOff.length + products.recurring.length;
}
