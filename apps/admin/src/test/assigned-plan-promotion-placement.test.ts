import { describe, expect, it } from 'vitest';
import {
  promotionGrants,
  thumbnailSrc,
} from '../components/assignedPlan/promotionPlacement';
import type { AppliedPromotion, AppliedPromotionGrant } from '../components/assignedPlan/types';

// #2657 — an applied Promotion is drawn once, as a plan-level row, and its
// benefit summary reads the application's own grants (#2478's placement under
// each Product is gone).

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

describe('promotionGrants (#2657)', () => {
  it('lists every grant of an application once, one-off then session then period', () => {
    const a = grant(5, 'waive');
    const b = grant(6);
    const c = grant(7);
    expect(promotionGrants(promotion(1, { session: [b], oneoff: [a], periodical: [c] }))).toEqual([a, b, c]);
  });

  it('is empty for a Membership Fee Promotion, which grants no Product', () => {
    expect(promotionGrants(promotion(1, {}))).toEqual([]);
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
