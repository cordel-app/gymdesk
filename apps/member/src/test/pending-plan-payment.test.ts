// #2744 — where the pending payment is shown: one plan card on My Products, and
// one notice on Home.
import { describe, expect, it } from 'vitest';
import { homePendingPayment, pendingPaymentPlanSnapshotId, type MemberSetView } from '../lib/memberProducts';

const plan = (id: number, over: Record<string, unknown> = {}) => ({ plan_snapshot_id: id, membership_plan_id: id, plan_name: `P${id}`, change: 'added' as const, ...over });
const view = (over: Partial<MemberSetView>): MemberSetView => ({ id: 1, status: 'pending_payment', owner_member_id: 7, lines: [], plans: [], ...over });

describe('pendingPaymentPlanSnapshotId', () => {
  it('names the first billed plan of the member\'s own version awaiting payment', () => {
    const v = view({ plans: [plan(3, { entitlement_only: true }), plan(4), plan(5)] });
    expect(pendingPaymentPlanSnapshotId(v, 7)).toBe(4);
  });

  it('names none for a version that is not pending, a family version, or no billed plan', () => {
    expect(pendingPaymentPlanSnapshotId(null, 7)).toBeNull();
    expect(pendingPaymentPlanSnapshotId(view({ status: 'draft', plans: [plan(4)] }), 7)).toBeNull();
    expect(pendingPaymentPlanSnapshotId(view({ status: 'active', plans: [plan(4)] }), 7)).toBeNull();
    expect(pendingPaymentPlanSnapshotId(view({ plans: [plan(4)] }), 8)).toBeNull();
    expect(pendingPaymentPlanSnapshotId(view({ plans: [plan(4)] }), null)).toBeNull();
    expect(pendingPaymentPlanSnapshotId(view({ plans: [] }), 7)).toBeNull();
  });
});

describe('homePendingPayment', () => {
  it('prefers the plan awaiting its first payment', () => {
    expect(homePendingPayment({ membership_fee: 40 }, [{ status: 'pending', source: 'customer', amount: '12.00' }]))
      .toEqual({ amount: 40, currency: 'EUR' });
  });

  it('falls back to an open membership-fee request, never a product purchase', () => {
    expect(homePendingPayment(null, [
      { status: 'pending', source: 'product_purchase', amount: '9.00' },
      { status: 'pending', source: 'customer', amount: '12.50', currency: 'EUR' },
    ])).toEqual({ amount: 12.5, currency: 'EUR' });
    expect(homePendingPayment(null, [{ status: 'pending', source: 'product_purchase', amount: '9.00' }])).toBeNull();
  });

  it('is nothing when nothing is pending', () => {
    expect(homePendingPayment(null, [{ status: 'completed', source: 'customer', amount: '12.00' }])).toBeNull();
    expect(homePendingPayment({ membership_fee: 0 }, [])).toBeNull();
  });
});
