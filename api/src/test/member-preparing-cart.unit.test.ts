// #3154 — the Members App's *Your gym is preparing a change* card, decided in
// `apps/member/src/lib/preparingCart.ts`: plans by name, Products as bullets,
// each with its thumbnail and applied Promotions, and the Promotions' main
// terms as locale keys with no amount. In the API suite for #1009's reason:
// CI runs `npm test` in `api/` only.
import { describe, expect, it } from 'vitest';
import {
  planPromotionTerms,
  preparingCartContent,
  productPromotionTerms,
} from '../../../apps/member/src/lib/preparingCart';
import type { MemberCartView } from '../../../apps/member/src/lib/memberCart';

const view: MemberCartView = {
  id: 9, status: 'in_cart', owner_member_id: 1, awaiting_staff_setup: true,
  plans: [
    {
      plan_snapshot_id: 3, membership_plan_id: 4, plan_name: 'Gold', change: 'added',
      plan_description: 'All access', plan_image_url: 'https://x/gold.webp', plan_image_thumbnail_url: 'https://x/gold-thumbnail.webp',
      benefits: [{ category: 'session', product_id: 7, name: 'Personal Training', quantity: 2, billing_frequency: 'month', unit_price: 30, mandatory: true }],
      promotions: [{ id: 11, promotion_id: 5, promotion_name: 'Welcome', description: 'New members', image_url: 'https://x/p.webp',
        image_thumbnail_url: 'https://x/p-thumbnail.webp', free_months: 1, paid_months: 0, bonus_months: null,
        membership_fee_benefit: { action: 'percentage_discount', value: 50, duration_months: 3 } }],
    },
    { plan_snapshot_id: 1, membership_plan_id: 2, plan_name: 'Held', change: 'inherited' },
  ],
  lines: [
    { id: 21, product_id: 8, change: 'added', product_name: 'Locker', image_thumbnail_url: 'https://x/l-thumbnail.webp',
      promotions: [{ id: 30, promotion_id: 6, promotion_name: 'Locker deal', benefit_action: 'fixed_price', benefit_value: 5, duration_cycles: 2 }] },
    { id: 20, product_id: 9, change: 'inherited', product_name: 'Towel' },
  ],
  purchases: [{ id: 40, product_id: 10, product_name: 'Water', amount: 2 }],
};

describe('preparingCartContent', () => {
  it('lists the added plans and the added Products, never an inherited one', () => {
    const c = preparingCartContent(view);
    expect(c.plans.map((p) => p.name)).toEqual(['Gold']);
    expect(c.products.map((p) => p.name)).toEqual(['Locker', 'Water']);
  });

  it('carries the thumbnail, the full image, the description and the included items without prices', () => {
    const [gold] = preparingCartContent(view).plans;
    expect(gold.thumbnailUrl).toBe('https://x/gold-thumbnail.webp');
    expect(gold.imageUrl).toBe('https://x/gold.webp');
    expect(gold.description).toBe('All access');
    expect(gold.included).toEqual([{ key: expect.any(String), name: 'Personal Training', quantity: 2 }]);
    expect(JSON.stringify(gold.included)).not.toContain('mandatory');
  });

  it('carries each applied Promotion with its thumbnail and terms', () => {
    const c = preparingCartContent(view);
    expect(c.plans[0].promotions[0]).toMatchObject({ name: 'Welcome', thumbnailUrl: 'https://x/p-thumbnail.webp', description: 'New members' });
    expect(c.products[0].promotions[0].name).toBe('Locker deal');
    expect(c.products[1].promotions).toEqual([]);
  });
});

describe('Promotion terms name no amount', () => {
  it('a plan Promotion: fee benefit, its duration and the Free / Paid / Bonus months above zero', () => {
    expect(planPromotionTerms({ promotion_id: 1, free_months: 1, paid_months: 0, membership_fee_benefit: { action: 'percentage_discount', value: 50, duration_months: 3 } }))
      .toEqual([
        { key: 'membership.preparing_term_fee_percentage', values: { value: '50' } },
        { key: 'membership.preparing_term_duration_months', values: { count: 3 } },
        { key: 'membership.preparing_term_free_months', values: { count: 1 } },
      ]);
    expect(planPromotionTerms({ promotion_id: 1, membership_fee_benefit: { action: 'fixed_price', value: 9.99, duration_months: null } }))
      .toEqual([{ key: 'membership.preparing_term_fee_fixed_price' }]);
  });

  it('a Product Promotion: a fixed amount reads as a special price, never the figure', () => {
    const terms = productPromotionTerms({ promotion_id: 1, benefit_action: 'fixed_price', benefit_value: 5, duration_cycles: 2 });
    expect(terms).toEqual([
      { key: 'membership.preparing_term_product_fixed_price' },
      { key: 'membership.promotion_duration_cycles', values: { count: 2 } },
    ]);
    expect(JSON.stringify(terms)).not.toContain('5');
  });
});

describe('the preparing card of a staff cart of standalone purchases (#3305)', () => {
  it('lists those purchases as its Products, with or without a staff Product Set', () => {
    const standalone = { purchases: [{ id: 60, product_id: 3, product_name: 'Gym bag', amount: 25 }], total: 25, currency: 'EUR', awaiting_staff_setup: true };
    expect(preparingCartContent(null, undefined, standalone).products.map((p) => p.name)).toEqual(['Gym bag']);
    expect(preparingCartContent(view, undefined, standalone).products.map((p) => p.name)).toEqual(['Locker', 'Water', 'Gym bag']);
    // The member's own standalone purchases are not the gym's.
    expect(preparingCartContent(view, undefined, { ...standalone, awaiting_staff_setup: false }).products.map((p) => p.name)).toEqual(['Locker', 'Water']);
  });
});
