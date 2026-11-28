import { describe, expect, it } from 'vitest';
import {
  billingMode, cancelRequestFor, inFlightSetTitle, pendingPlanChangeCount, cartCancelContents, cartCancelIntroKey, contractedMembersText, discountText, lineReducedToZero, splitContracted, pendingCancelErrorKey, pendingOneOffCount, saveAndPayEnabled, saveAndPayTarget, withoutZeroRows, psStatusKey, standaloneCartCount, cartExpirySeconds, hasCartInCart, summaryCancelRequest, summaryCancelContents, standaloneCartNames,
} from '@/app/[locale]/members/productsWorkflowView';
import { displayedEndsAt } from '@/components/assignedPlan/assignedPlanProfile';

const set = (status: string, expired = false) => ({ id: 1, status, plan_name: null, starts_at: null, ends_at: null, created_at: null, created_by: null, expired });
const changed = { changes: [{}], amount_due: 10 };

describe('#1613 products workflow', () => {
  it('shows the persisted ledger when nothing affects billing', () => {
    expect(billingMode({ current: null, review: null, pendingOneOffs: 0 })).toBe('events');
    expect(billingMode({ current: set('active'), review: null, pendingOneOffs: 0 })).toBe('events');
    // an opened-but-unchanged Draft is a dirty form, not a billing change
    expect(billingMode({ current: set('in_cart'), review: { changes: [], amount_due: 0 }, pendingOneOffs: 0 })).toBe('events');
  });
  it('switches to simulation on a billing-affecting change or a pending one-off', () => {
    expect(billingMode({ current: set('in_cart'), review: changed, pendingOneOffs: 0 })).toBe('simulation');
    expect(billingMode({ current: set('active'), review: null, pendingOneOffs: 1 })).toBe('simulation');
    expect(billingMode({ current: set('pending_payment'), review: null, pendingOneOffs: 0 })).toBe('simulation');
    expect(billingMode({ current: set('in_cart', true), review: changed, pendingOneOffs: 0 })).toBe('events');
  });
  it('enables Save & Pay by the same pending state and respects write access', () => {
    const w = { current: set('in_cart'), review: changed, pendingOneOffs: 0 };
    expect(saveAndPayEnabled({ ...w, canWrite: true })).toBe(true);
    expect(saveAndPayEnabled({ ...w, canWrite: false })).toBe(false);
    expect(saveAndPayEnabled({ current: set('active'), review: null, pendingOneOffs: 0, canWrite: true })).toBe(false);
  });
  it('routes a lone one-off to its own payment link', () => {
    expect(saveAndPayTarget({ current: set('active'), review: null, pendingOneOffs: 1 })).toBe('purchases');
    expect(saveAndPayTarget({ current: set('in_cart'), review: changed, pendingOneOffs: 1 })).toBe('review');
  });
  it('counts only purchases awaiting payment', () => {
    expect(pendingOneOffCount([{ status: 'pending_payment' }, { status: 'active' }])).toBe(1);
  });
  it('hides zero rows for display without touching totals or the input', () => {
    const sim = { total: 5, dates: [
      { total: 5, lines: [{ actual_charge: 5 }, { actual_charge: 0 }] },
      { total: 0, lines: [{ actual_charge: 0 }] },
    ] };
    const out = withoutZeroRows(sim, true)!;
    expect(out.dates).toHaveLength(1);
    expect(out.dates[0].lines).toHaveLength(1);
    expect(out.total).toBe(5);
    expect(sim.dates).toHaveLength(2);
    expect(withoutZeroRows(sim, false)).toBe(sim);
  });
  it('maps only known statuses to a label key', () => {
    expect(psStatusKey(set('active'))).toBe('active');
    expect(psStatusKey(set('weird'))).toBeNull();
    expect(psStatusKey(null)).toBeNull();
  });
  it('reads the ProductSet\'s own status, whatever it holds (#2804)', () => {
    // An Active set with no plan and no Products (all cancelled) is Active, not None.
    expect(psStatusKey({ ...set('active'), plan_name: null } as any)).toBe('active');
    // A set whose only plan cancels on its end date is carried for entitlement
    // only, so it names no primary plan either: still Active.
    expect(psStatusKey({ ...set('active'), plan_name: null, plan_status: null } as any)).toBe('active');
    expect(psStatusKey({ ...set('active'), plan_name: 'Gold' } as any)).toBe('active');
    expect(psStatusKey({ ...set('in_cart'), plan_name: null } as any)).toBe('in_cart');
  });
});

describe('#2747 stage 2 — what Cancel does to the in-flight version', () => {
  it('discards a Draft and cancels-and-keeps a version awaiting payment', () => {
    expect(cancelRequestFor({ id: 4, status: 'in_cart' })).toEqual({ kind: 'discard_draft', path: '/product-sets/4', method: 'DELETE' });
    expect(cancelRequestFor({ id: 4, status: 'pending_payment' })).toEqual({ kind: 'cancel_pending', path: '/product-sets/4/cancel', method: 'POST' });
  });

  it('offers no Cancel for any other version', () => {
    for (const status of ['active', 'superseded', 'cancelled']) expect(cancelRequestFor({ id: 4, status })).toBeNull();
    expect(cancelRequestFor(null)).toBeNull();
  });

  it('explains a refused cancel by the server\'s code', () => {
    expect(pendingCancelErrorKey('payment_settled')).toBe('ps_cancel_pending_error_settled');
    expect(pendingCancelErrorKey('payment_unresolved')).toBe('ps_cancel_pending_error_unresolved');
    expect(pendingCancelErrorKey('anything')).toBe('ps_cancel_pending_error');
  });
});

describe('#2860 checkout summary', () => {
  const item = (period: 'one_off' | 'recurring', name: string) => ({
    kind: 'product' as const, name, period, billing_frequency: null, cadence: null, quantity: 1, members: [], included: [],
  });

  it('separates recurring items from one-off ones, keeping the server order', () => {
    const { recurring, oneOff } = splitContracted([item('recurring', 'Plan'), item('one_off', 'Water'), item('recurring', 'Towel')]);
    expect(recurring.map((i) => i.name)).toEqual(['Plan', 'Towel']);
    expect(oneOff.map((i) => i.name)).toEqual(['Water']);
  });

  it('names the members, and none means the whole family', () => {
    expect(contractedMembersText([{ member_id: 1, name: 'Ana' }, { member_id: 2, name: null }])).toBe('Ana, #2');
    expect(contractedMembersText([])).toBeNull();
  });

  it('says what a discount is: the Promotion, else the line treatment, and nothing without one', () => {
    const l = { name: 'x', quantity: 1, unit_price: 10, line_total: 10, discount: 2, promotion_name: null, treatment_action: null, treatment_value: null, tax_rate_percent: null, tax_amount: 0, amount: 8 };
    expect(discountText({ ...l, discount: 0 })).toBeNull();
    expect(discountText({ ...l, promotion_name: 'Spring' })).toEqual({ text: 'Spring' });
    expect(discountText({ ...l, treatment_action: 'percentage_discount', treatment_value: 20 })).toEqual({ key: 'checkout_discount_percent', values: { percent: 20 } });
    expect(discountText({ ...l, treatment_action: 'waive' })).toEqual({ key: 'checkout_discount_waived' });
    expect(discountText(l)).toEqual({ key: 'checkout_discount_direct' });
  });

  it('#2890: marks a line a benefit takes to €0.00, and only that one', () => {
    expect(lineReducedToZero({ discount: 500, amount: 0 })).toBe(true);
    expect(lineReducedToZero({ discount: 3, amount: 27 })).toBe(false);
    expect(lineReducedToZero({ discount: 0, amount: 0 })).toBe(false);
  });
});

describe('#2965 the standalone cart', () => {
  it('counts only in-cart purchases no Product Set carries', () => {
    expect(standaloneCartCount([
      { status: 'in_cart', cart_expires_at: '2026-11-17T14:00:00Z' },
      { status: 'in_cart', cart_expires_at: null },
      { status: 'pending_payment', cart_expires_at: null },
    ])).toBe(1);
  });
  it('a Draft with no changes but standalone purchases still opens the review', () => {
    const w = { current: set('in_cart'), review: { changes: [], amount_due: 15 }, pendingOneOffs: 0, cartPurchases: 1 };
    expect(saveAndPayTarget(w)).toBe('review');
    expect(saveAndPayEnabled({ ...w, canWrite: true })).toBe(true);
  });
  it('with no Draft the standalone cart is paid on its own', () => {
    for (const current of [null, set('active'), set('in_cart', true)]) {
      const w = { current, review: null, pendingOneOffs: 0, cartPurchases: 2 };
      expect(saveAndPayTarget(w)).toBe('cart');
      expect(saveAndPayEnabled({ ...w, canWrite: true })).toBe(true);
      expect(saveAndPayEnabled({ ...w, canWrite: false })).toBe(false);
    }
  });
  it('a version awaiting payment keeps its own review', () => {
    expect(saveAndPayTarget({ current: set('pending_payment'), review: null, pendingOneOffs: 0, cartPurchases: 1 })).toBe('review');
  });
});

describe('#3162 cancel-cart confirmation contents', () => {
  const item = (kind: 'plan' | 'product', name: string) => ({ kind, name, period: 'recurring' as const, billing_frequency: null, cadence: null, quantity: 1, members: [], included: [] });
  it('names the plans and the Products of the cart, apart, in the server order', () => {
    const review = { contracted_items: [item('plan', 'Gold'), item('product', 'Locker'), item('plan', 'Kids'), item('product', 'Towel')] };
    expect(cartCancelContents(review)).toEqual({ plans: ['Gold', 'Kids'], products: ['Locker', 'Towel'] });
  });
  it('leaves a section empty (omitted by the dialog) and copes with no review', () => {
    expect(cartCancelContents({ contracted_items: [item('product', 'Locker')] })).toEqual({ plans: [], products: ['Locker'] });
    expect(cartCancelContents(null)).toEqual({ plans: [], products: [] });
  });
});

describe('#3162 cancel-cart opening sentence', () => {
  it('announces the lists when the cart holds anything, and stands alone when it holds nothing', () => {
    expect(cartCancelIntroKey({ plans: ['Gold'], products: [] })).toBe('ps_cancel_intro');
    expect(cartCancelIntroKey({ plans: [], products: ['Locker'] })).toBe('ps_cancel_intro');
    expect(cartCancelIntroKey({ plans: [], products: [] })).toBe('ps_cancel_intro_empty');
  });
});

describe('#3114 stage 3 — a cart that only reactivates (or cancels) a plan', () => {
  const reactivating = {
    changes: [], amount_due: 0,
    plans_to_reactivate: [{ user_membership_id: 7, plan_name: 'Gold' }], plans_to_cancel: [],
  };
  it('is a change: simulation, Save & Pay through the review', () => {
    const w = { current: set('in_cart'), review: reactivating, pendingOneOffs: 0 };
    expect(pendingPlanChangeCount(reactivating)).toBe(1);
    expect(billingMode(w)).toBe('simulation');
    expect(saveAndPayTarget(w)).toBe('review');
    expect(saveAndPayEnabled({ ...w, canWrite: true })).toBe(true);
    const cancelling = { changes: [], amount_due: 0, plans_to_cancel: [{ user_membership_id: 8, plan_name: 'Silver' }] };
    expect(billingMode({ current: set('in_cart'), review: cancelling, pendingOneOffs: 0 })).toBe('simulation');
  });
  it('titles the Summary with the reactivated plan rather than "Products only"', () => {
    expect(inFlightSetTitle({ plan_name: null }, reactivating)).toBe('Gold');
    expect(inFlightSetTitle({ plan_name: 'Own' }, reactivating)).toBe('Own');
    expect(inFlightSetTitle({ plan_name: null }, null)).toBeNull();
  });
  it('reads open-ended in the plan list while the stored end date stays', () => {
    expect(displayedEndsAt({ ends_at: '2026-12-06', lifecycle_status: 'to_be_reactivated' })).toBeNull();
    expect(displayedEndsAt({ ends_at: '2026-12-06', lifecycle_status: 'cancels_on_end_date' })).toBe('2026-12-06');
  });
});

describe('#3274 follow-up — the cart has one countdown, the purchase\'s', () => {
  const now = Date.parse('2026-11-24T12:00:00Z');
  const inCartSet = (seconds: number | null, expired = false) => ({ status: 'in_cart', expired, expires_in_seconds: seconds });
  it('reads the in-cart set\'s seconds, which the server takes from the purchase', () => {
    expect(cartExpirySeconds(inCartSet(5400), [], now)).toBe(5400);
  });
  it('reads a standalone cart from its purchases\' cart_expires_at', () => {
    expect(cartExpirySeconds(null, [{ status: 'in_cart', cart_expires_at: '2026-11-24T13:30:00Z' }], now)).toBe(5400);
  });
  it('gives one value for a cart holding a set and standalone Products', () => {
    expect(cartExpirySeconds(inCartSet(5400), [
      { status: 'in_cart', cart_expires_at: '2026-11-24T13:30:00Z' },
      { status: 'in_cart', cart_expires_at: '2026-11-24T13:30:00Z' },
    ], now)).toBe(5400);
  });
  it('shows nothing outside In Cart', () => {
    expect(cartExpirySeconds({ status: 'pending_payment', expired: false, expires_in_seconds: null }, [{ status: 'pending_payment', cart_expires_at: null }], now)).toBeNull();
    expect(cartExpirySeconds(inCartSet(100, true), [], now)).toBeNull();
    expect(hasCartInCart({ status: 'active', expired: false }, [])).toBe(false);
    expect(hasCartInCart({ status: 'in_cart', expired: false }, [])).toBe(true);
    expect(hasCartInCart(null, [{ status: 'in_cart', cart_expires_at: '2026-11-24T13:30:00Z' }])).toBe(true);
  });
  it('never counts below zero', () => {
    expect(cartExpirySeconds(null, [{ status: 'in_cart', cart_expires_at: '2026-11-24T11:00:00Z' }], now)).toBe(0);
  });
});

// #3381 stage 2 — the formula under a line's Base Price, from the server's own factors.
import { basePriceFormula } from '@/app/[locale]/members/productsWorkflowView';
describe('basePriceFormula', () => {
  const money = (n: number) => `${n.toFixed(2)} €`;
  it('states Qty × the base price × the proration of a prorated line', () => {
    expect(basePriceFormula({ quantity: 2, unit_price: 7.5, days: 6, period_days: 30 }, money)).toBe('2 × 7.50 € × 6/30');
  });
  it('omits the proration on a line that was not prorated', () => {
    expect(basePriceFormula({ quantity: 3, unit_price: 10, days: null, period_days: null }, money)).toBe('3 × 10.00 €');
  });
});

describe('#3554 — the Summary Cancel of a cart of standalone one-time Products', () => {
  const cart = [
    { status: 'in_cart', cart_expires_at: '2026-11-28T03:00:00Z', product_name: 'Towel' },
    { status: 'in_cart', cart_expires_at: null, product_name: 'Recurring line' },
    { status: 'active', cart_expires_at: null, product_name: 'Bought' },
  ];
  const input = (current: any, cartPurchases: number) => ({
    current, review: null, pendingOneOffs: 0, cartPurchases, cartProductNames: standaloneCartNames(cart),
  });

  it('discards a cart of standalone purchases alone through the cart route', () => {
    expect(summaryCancelRequest(input(null, 1), 7)).toEqual({ kind: 'discard_cart', path: '/members/7/product-purchases/cart', method: 'DELETE' });
    expect(summaryCancelRequest(input({ id: 2, status: 'active' }, 1), 7)?.kind).toBe('discard_cart');
    expect(summaryCancelContents(input(null, 1))).toEqual({ plans: [], products: ['Towel'] });
  });

  it('keeps the Draft\'s own Cancel for a mixed cart and offers none for an empty one', () => {
    expect(summaryCancelRequest(input({ id: 4, status: 'in_cart' }, 1), 7)?.kind).toBe('discard_draft');
    expect(summaryCancelRequest(input({ id: 4, status: 'pending_payment' }, 1), 7)?.kind).toBe('cancel_pending');
    expect(summaryCancelRequest(input(null, 0), 7)).toBeNull();
    expect(summaryCancelRequest(input({ id: 2, status: 'active' }, 0), 7)).toBeNull();
  });
});
