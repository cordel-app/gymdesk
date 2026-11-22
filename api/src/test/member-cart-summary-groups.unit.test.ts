// #2973 stage 8 — the Members App cart Summary groups each contracted plan with the
// Products it includes, and lists the Products contracted on their own separately. In
// the API suite because CI runs `npm test` in `api/` only.
import { describe, expect, it } from 'vitest';
import { reviewContractedGroups, type MemberSetReview } from '../../../apps/member/src/lib/memberProducts';

const item = (over: Partial<MemberSetReview['summary_items'][number]>) => ({
  state: 'draft' as const, type: 'product' as const, name: '', quantity: null, billing_frequency: null,
  regular_price: null, promotions: [], initial_amount: null, final_price: null, ...over,
});

const review = (over: Partial<MemberSetReview>): MemberSetReview => ({
  product_set_id: 1, status: 'in_cart', summary_items: [], immediate_lines: [], amount_due: 0,
  payment_required: false, tax_total: null, currency: 'EUR', error: null, ...over,
});

describe('reviewContractedGroups', () => {
  const r = review({
    summary_items: [
      item({ type: 'plan', name: 'Family Gold', billing_frequency: '1_month', regular_price: 80 }),
      item({ type: 'plan', name: 'Kept', state: 'active' }),
      item({ type: 'product', name: 'Locker', billing_frequency: 'month', quantity: 1, regular_price: 10 }),
      item({ type: 'product', name: 'Old', state: 'cancelling' }),
    ],
    contracted_items: [
      { kind: 'plan', name: 'Family Gold', members: [{ member_id: 1, name: 'Ana' }, { member_id: 2, name: 'Bo' }],
        included: [
          { name: 'Locker', quantity: 1, billing_frequency: 'month', members: [{ member_id: 2, name: 'Bo' }] },
          { name: 'Towel', quantity: 2, billing_frequency: 'month', members: [] },
        ] } as any,
      { kind: 'plan', name: 'Kept', members: [], included: [{ name: 'Sauna', quantity: 1, billing_frequency: null, members: [] }] } as any,
      { kind: 'product', name: 'Locker', period: 'recurring', members: [{ member_id: 1, name: 'Ana' }] } as any,
      { kind: 'product', name: 'Water', period: 'one_off', members: [{ member_id: 1, name: 'Ana' }] } as any,
    ],
  });
  const groups = reviewContractedGroups(r);

  it('nests a contracted plan\'s included Products beneath it', () => {
    expect(groups.plans).toHaveLength(1);
    expect(groups.plans[0].plan.name).toBe('Family Gold');
    expect(groups.plans[0].included).toEqual([
      { name: 'Locker', quantity: 1, billing_frequency: 'month', beneficiary: { name: 'Bo' } },
      { name: 'Towel', quantity: 2, billing_frequency: 'month', beneficiary: { family: true } },
    ]);
  });

  it('lists standalone Products separately, keeping one named like an included Product', () => {
    expect(groups.products.map((p) => p.name)).toEqual(['Locker', 'Water']);
    expect(groups.products[0]).toMatchObject({ price: 10, billing_frequency: 'month', beneficiary: { name: 'Ana' } });
    expect(groups.products[1]).toMatchObject({ beneficiary: { name: 'Ana' }, price: null });
  });

  it('leaves unchanged and cancelled items out of the contracted groups', () => {
    expect(groups.plans.map((g) => g.plan.name)).not.toContain('Kept');
    expect(groups.products.map((p) => p.name)).not.toContain('Old');
  });

  it('lists a standalone cart purchase once when the items already name it', () => {
    const cart = reviewContractedGroups(review({
      summary_items: [item({ name: 'Water', quantity: 2, regular_price: 2 })],
      contracted_items: [{ kind: 'product', name: 'Water', period: 'one_off', members: [{ member_id: 1, name: 'Ana' }] } as any],
    }));
    expect(cart.plans).toEqual([]);
    expect(cart.products).toHaveLength(1);
    expect(cart.products[0]).toMatchObject({ name: 'Water', quantity: 2, price: 2 });
  });

  it('answers empty groups without a review', () => {
    expect(reviewContractedGroups(null)).toEqual({ plans: [], products: [] });
  });
});
