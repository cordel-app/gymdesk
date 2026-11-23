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
  /** #3236: what the confirmation dialog shows of the Product and of the Promotion. */
  product_description?: string | null;
  product_image_url?: string | null;
  product_image_thumbnail_url?: string | null;
  promotion_name?: string | null;
  promotion_description?: string | null;
  promotion_image_url?: string | null;
  promotion_image_thumbnail_url?: string | null;
}

/** #3236: a chosen Promotion that makes a Product required. */
export interface RequiringPromotion {
  id: number;
  name: string;
  description: string | null;
  image_url: string | null;
  image_thumbnail_url: string | null;
}

export interface RequiredProduct {
  id: number;
  name: string;
  description: string | null;
  image_url: string | null;
  image_thumbnail_url: string | null;
  /** #3236: the chosen Promotions that require it, in grant order, each once. */
  required_by: RequiringPromotion[];
}

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
    if (id === currentProductId || ownedProductIds.has(id)) continue;
    if (!isPromotionItemRequirement(g.requirement) || g.requirement !== 'mandatory') continue;
    let item = out.get(id);
    if (!item) {
      item = {
        id,
        name: g.product_name,
        description: g.product_description ?? null,
        image_url: g.product_image_url ?? null,
        image_thumbnail_url: g.product_image_thumbnail_url ?? null,
        required_by: [],
      };
      out.set(id, item);
    }
    const promotionId = Number(g.promotion_id);
    if (!item.required_by.some((p) => p.id === promotionId)) {
      item.required_by.push({
        id: promotionId,
        name: g.promotion_name ?? '',
        description: g.promotion_description ?? null,
        image_url: g.promotion_image_url ?? null,
        image_thumbnail_url: g.promotion_image_thumbnail_url ?? null,
      });
    }
  }
  return [...out.values()];
}
