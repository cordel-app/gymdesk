import { describe, expect, it } from 'vitest';
import {
  placePromotionsUnderProducts,
  thumbnailSrc,
} from '../components/assignedPlan/promotionPlacement';
import type { AppliedPromotion, AppliedPromotionGrant } from '../components/assignedPlan/types';

// #2478 — where each applied Promotion is drawn on the Assigned Plan card:
// under every Product line one of its grants names, or under the Membership
// Fee when it names none, so no application ever disappears from the card.

function grant(productId: number | null, action = 'percentage_discount'): AppliedPromotionGrant {
  return {
    product_id: productId, item_name: `P${productId}`, quantity: 1, item_billing_frequency: null,
    unit_price: 10, action: action as any, value: 10,
    original_price_incl_tax: 10, final_price_incl_tax: 9,
    original_line_price_incl_tax: 10, final_line_price_incl_tax: 9,
  };
}

function promotion(id: number, grants: Partial<Record<'oneoff' | 'session' | 'periodical', AppliedPromotionGrant[]>>): AppliedPromotion {
  return {
    id, promotion_id: id, status: 'applied', display_status: 'active', can_reapply: false,
    applied_at: '2026-01-01T00:00:00Z', revoked_at: null, created_by: null,
    promotion_name: `Promo ${id}`, promotion_description: null, starts_at: null, ends_at: null,
    free_months: null, paid_months: null, bonus_months: null, membership_fee_benefits: [],
    oneoff_grants: grants.oneoff ?? [], session_grants: grants.session ?? [],
    periodical_grants: grants.periodical ?? [],
  };
}

describe('placePromotionsUnderProducts (#2478)', () => {
  it('puts an application under the Product its grant names', () => {
    const p = promotion(1, { oneoff: [grant(5)] });
    const { byProduct, unplaced } = placePromotionsUnderProducts([p], [5, 6]);
    expect(byProduct.get(5)?.map((x) => x.promotion.id)).toEqual([1]);
    expect(byProduct.get(6)).toBeUndefined();
    expect(unplaced).toEqual([]);
  });

  it('puts one application under every Product it grants, once each, with that Product\'s grant', () => {
    const towel = grant(5, 'waive');
    const p = promotion(1, { oneoff: [towel], periodical: [grant(6)], session: [grant(5)] });
    const { byProduct } = placePromotionsUnderProducts([p], [5, 6]);
    expect(byProduct.get(5)).toEqual([{ promotion: p, grant: towel }]);
    expect(byProduct.get(6)?.map((x) => x.promotion.id)).toEqual([1]);
  });

  it('keeps an application that grants none of the card\'s Products, for the Membership Fee', () => {
    const fee = promotion(1, {});
    const elsewhere = promotion(2, { oneoff: [grant(99)], periodical: [grant(null)] });
    const { byProduct, unplaced } = placePromotionsUnderProducts([fee, elsewhere], [5]);
    expect(byProduct.size).toBe(0);
    expect(unplaced.map((p) => p.id)).toEqual([1, 2]);
  });

  it('keeps the card order under a Product', () => {
    const { byProduct } = placePromotionsUnderProducts(
      [promotion(2, { oneoff: [grant(5)] }), promotion(1, { oneoff: [grant(5)] })], [5],
    );
    expect(byProduct.get(5)?.map((x) => x.promotion.id)).toEqual([2, 1]);
  });
});

describe('thumbnailSrc (#2478)', () => {
  it('prefers the thumbnail, falls back to the master, and draws nothing without a usable URL', () => {
    expect(thumbnailSrc('https://x/t.webp', 'https://x/m.webp')).toBe('https://x/t.webp');
    expect(thumbnailSrc(null, 'https://x/m.webp')).toBe('https://x/m.webp');
    expect(thumbnailSrc(null, null)).toBeNull();
    expect(thumbnailSrc('javascript:alert(1)', null)).toBeNull();
  });
});
