import { describe, it, expect } from 'vitest';
import { pendingPaymentPlanSets, visiblePlans } from '../app/[locale]/members/membershipPlansView';

const plan = (id: number, status: string, is_live = true) => ({ id, status, is_live } as any);

describe('#1538 visiblePlans — one version of the plan at a time', () => {
  it('shows the Active plan and the in-progress list when nothing is being edited', () => {
    const v = visiblePlans([plan(1, 'active')]);
    expect(v.rows.map((r) => r.id)).toEqual([1]);
    expect(v.heading).toBe('active');
    expect(v.showInFlightList).toBe(true);
  });

  it('a Draft replaces the Active snapshot in the view, never both', () => {
    const v = visiblePlans([plan(1, 'active'), plan(2, 'draft')]);
    expect(v.rows.map((r) => r.id)).toEqual([2]);
    expect(v.heading).toBe('draft');
    expect(v.showInFlightList).toBe(false);
  });

  it('a Pending Payment version also replaces it, and is not listed twice', () => {
    const v = visiblePlans([plan(1, 'active'), plan(3, 'pending_payment')]);
    expect(v.rows.map((r) => r.id)).toEqual([3]);
    expect(v.showInFlightList).toBe(false);
    // #2742: awaiting payment is listed in the Active category, labelled by its badge.
    expect(v.heading).toBe('active');
  });

  it('#2742: a Draft beside a Pending Payment version still takes the view out of Active', () => {
    expect(visiblePlans([plan(2, 'draft'), plan(3, 'pending_payment')]).heading).toBe('draft');
  });

  it('with no plan the empty state is untouched', () => {
    const v = visiblePlans([]);
    expect(v.rows).toEqual([]);
    expect(v.heading).toBe('active');
  });

  it('past plans never enter the first table', () => {
    const v = visiblePlans([plan(1, 'cancelled', false)]);
    expect(v.rows).toEqual([]);
  });
});

describe('#1538 stage 3 canEditLivePlan', () => {
  const base = { status: 'active', is_live: true, assignment_relationship: 'primary' as const, membership_plan_id: 5 };
  it('is offered on the running plan', async () => {
    const { canEditLivePlan } = await import('../app/[locale]/members/membershipPlansView');
    expect(canEditLivePlan(base)).toBe(true);
    expect(canEditLivePlan({ ...base, status: 'paused' })).toBe(true);
  });
  it('is not offered on an in-flight, linked, past or plan-less row', async () => {
    const { canEditLivePlan } = await import('../app/[locale]/members/membershipPlansView');
    expect(canEditLivePlan({ ...base, status: 'draft' })).toBe(false);
    expect(canEditLivePlan({ ...base, status: 'pending_payment' })).toBe(false);
    expect(canEditLivePlan({ ...base, assignment_relationship: 'linked' })).toBe(false);
    expect(canEditLivePlan({ ...base, is_live: false })).toBe(false);
    expect(canEditLivePlan({ ...base, membership_plan_id: null })).toBe(false);
  });
});

describe('#2549: cancelled plans with a future end date stay Active', () => {
  it('lists them in Active rows, keeps past ones out', () => {
    const cancelledValid = { id: 1, status: 'cancelled', is_live: false, is_current: true } as any;
    const cancelledPast = { id: 2, status: 'cancelled', is_live: false, is_current: false } as any;
    const active = plan(3, 'active');
    expect(visiblePlans([cancelledValid, cancelledPast, active]).rows.map((p: any) => p.id)).toEqual([1, 3]);
  });
});

describe('#2659 stage 3: a Draft lists the plans cancelling at their period end beside it', () => {
  it('keeps a Cancels-on-End-Date plan, replaces the Active one, never lists a finished one', () => {
    const cancelling = { id: 1, status: 'active_cancel_at_period_end', is_live: false, is_current: true } as any;
    const finished = { id: 2, status: 'cancelled', is_live: false, is_current: false } as any;
    const v = visiblePlans([plan(3, 'active'), cancelling, finished, plan(4, 'draft')]);
    expect(v.rows.map((r: any) => r.id)).toEqual([4, 1]);
    expect(v.heading).toBe('draft');
  });
});

describe('#2742 pendingPaymentPlanSets', () => {
  const set = (id: number, status: string, user_membership_id: number | null, membership_plan_id: number | null = 7) =>
    ({ id, status, user_membership_id, membership_plan_id, plan_name: 'Gold', starts_at: '2026-11-12', amount_due: 30, expired: false, created_by: null });
  it('lists a plan awaiting payment that no assignment represents yet', () => {
    expect(pendingPaymentPlanSets([set(1, 'pending_payment', null)]).map((s) => s.id)).toEqual([1]);
  });
  it('never lists a version an assignment row already shows, a Draft, or a set with no plan', () => {
    expect(pendingPaymentPlanSets([
      set(1, 'pending_payment', 42), set(2, 'draft', null), set(3, 'pending_payment', null, null),
    ])).toEqual([]);
  });
});
