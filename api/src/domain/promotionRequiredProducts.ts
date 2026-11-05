// #2374 — which *other* Products a Promotion obliges a staff member to take with the
// Product being added to a Member.
//
// The Product ↔ Promotion relationship carries `requirement` (`mandatory` |
// `optional`, #959, migration 207). Only `mandatory` ones can ever be required here;
// `optional` ones are never added, never listed. `products.mandatory` (the catalogue
// flag of Membership Plan benefits, #832) plays no part in it. Pure — no DB.

import { isPromotionItemRequirement } from './promotionItemRequirement';

export interface PromotionGrantRef {
  promotion_id: number;
  product_id: number;
  product_name: string;
  requirement: unknown;
}

export interface RequiredProduct { id: number; name: string }

/**
 * The mandatory Products of the chosen Promotions that the Member does not yet hold,
 * excluding the Product currently being added. Each Product appears once.
 */
export function missingMandatoryProducts(
  grants: readonly PromotionGrantRef[],
  currentProductId: number,
  ownedProductIds: ReadonlySet<number>,
): RequiredProduct[] {
  const out = new Map<number, RequiredProduct>();
  for (const g of grants) {
    const id = Number(g.product_id);
    if (id === currentProductId || ownedProductIds.has(id) || out.has(id)) continue;
    if (!isPromotionItemRequirement(g.requirement) || g.requirement !== 'mandatory') continue;
    out.set(id, { id, name: g.product_name });
  }
  return [...out.values()];
}
