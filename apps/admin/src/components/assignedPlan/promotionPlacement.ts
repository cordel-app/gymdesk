// #2478 — where each applied Promotion is drawn on the Assigned Plan card.
//
// The separate Promotions section is gone: an application is drawn directly
// under every Product line of the card that one of its grants names, and an
// application whose grants name no Product line of the card (a Membership
// Fee Promotion, or one granting a Product the plan does not carry) is drawn
// under the Membership Fee instead, so no application disappears from the card.
//
// This module only *places*: one application drawn under two Products is still
// one application (one checkbox, one revoke), and every price stays the
// server's. Pure, so the placement is asserted without rendering.

import { SAFE_IMAGE_SRC } from '@/lib/exerciseImageUpload';
import type { AppliedPromotion, AppliedPromotionGrant } from './types';

export interface PlacedPromotion {
  promotion: AppliedPromotion;
  /** The application's grant for this Product — its discount is what the row states. */
  grant: AppliedPromotionGrant;
}

export interface PromotionPlacement {
  /** Product id → the applications drawn under that Product's line(s), card order kept. */
  byProduct: Map<number, PlacedPromotion[]>;
  /** Applications no Product line of the card is granted by: drawn under the Membership Fee. */
  unplaced: AppliedPromotion[];
}

export function promotionGrants(p: AppliedPromotion): AppliedPromotionGrant[] {
  return [...(p.oneoff_grants ?? []), ...(p.session_grants ?? []), ...(p.periodical_grants ?? [])];
}

export function placePromotionsUnderProducts(
  promotions: AppliedPromotion[], productIds: Iterable<number>,
): PromotionPlacement {
  const onCard = new Set(productIds);
  const byProduct = new Map<number, PlacedPromotion[]>();
  const unplaced: AppliedPromotion[] = [];
  for (const promotion of promotions) {
    let placed = false;
    const seen = new Set<number>();
    for (const grant of promotionGrants(promotion)) {
      const id = grant.product_id;
      if (id == null || !onCard.has(id) || seen.has(id)) continue;
      seen.add(id);
      placed = true;
      const list = byProduct.get(id) ?? [];
      list.push({ promotion, grant });
      byProduct.set(id, list);
    }
    if (!placed) unplaced.push(promotion);
  }
  return { byProduct, unplaced };
}

/**
 * The thumbnail a row draws: the 256 px one, else the master. `null` — and so
 * no thumbnail and no reserved space at all — when there is no usable URL.
 */
export function thumbnailSrc(
  thumbnail: string | null | undefined, master: string | null | undefined,
): string | null {
  const src = thumbnail || master || null;
  return src && SAFE_IMAGE_SRC.test(src) ? src : null;
}
