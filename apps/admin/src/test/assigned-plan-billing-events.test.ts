import { describe, expect, it } from 'vitest';
import { showsBillingSimulations, viewBillingEventsPath } from '@/components/assignedPlan/assignedPlanBillingEvents';

// #2553 — the rules both Admin entry points to an Assigned Plan share.
describe('showsBillingSimulations', () => {
  it('shows for Draft and Pending Payment only', () => {
    expect(showsBillingSimulations('draft')).toBe(true);
    expect(showsBillingSimulations('pending_payment')).toBe(true);
    for (const s of ['active', 'paused', 'cancelled', 'expired', '', null, undefined]) {
      expect(showsBillingSimulations(s as any)).toBe(false);
    }
  });
});

describe('viewBillingEventsPath', () => {
  it('opens the Billing Events view (not Payments) filtered to the plan, keeping the Member', () => {
    const url = new URL('http://x' + viewBillingEventsPath('en', { id: 7, plan_name: 'Gold', member_id: 3, member_name: 'Ann Lee' }));
    expect(url.pathname).toBe('/en/payments/billing-events');
    expect(url.searchParams.get('userMembershipId')).toBe('7');
    expect(url.searchParams.get('memberId')).toBe('3');
    expect(url.searchParams.get('memberName')).toBe('Ann Lee');
    expect(url.searchParams.get('planName')).toBe('Gold');
  });
});
