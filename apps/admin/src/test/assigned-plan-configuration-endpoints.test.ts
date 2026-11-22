import { describe, expect, it } from 'vitest';
import { configurationEndpoints, withoutCadence } from '../components/assignedPlan/configurationEndpoints';

// #2966 stage 10 — the one editor writes an assignment through its own routes and a plan added to a
// cart through the stage-9 routes, by its plan snapshot.
describe('configurationEndpoints', () => {
  it('keeps an assignment on /user-memberships, cadence included', () => {
    const e = configurationEndpoints({ kind: 'assignment', assignedPlanId: 7 });
    expect(e.billingDuration).toBe('/user-memberships/7/billing-duration');
    expect(e.feeBenefit).toBe('/user-memberships/7/fee-benefit');
    expect(e.benefits('session', 'session-benefits')).toBe('/user-memberships/7/session-benefits');
    expect(e.cadenceEditable).toBe(true);
  });

  it('addresses a cart plan by its set and plan snapshot, with no cadence', () => {
    const e = configurationEndpoints({ kind: 'cart_plan', productSetId: 12, planSnapshotId: 345 });
    expect(e.billingDuration).toBe('/product-sets/12/plans/345/billing-duration');
    expect(e.feeBenefit).toBe('/product-sets/12/plans/345/fee-benefit');
    expect(e.benefits('periodical', 'periodical-benefits')).toBe('/product-sets/12/plans/345/benefits/periodical');
    expect(e.cadenceEditable).toBe(false);
  });

  it('drops the cadence from a Billing & Duration body and keeps the rest', () => {
    expect(withoutCadence({ paid_periods: 3, recurring_billing_interval: 1, recurring_billing_unit: 'month' }))
      .toEqual({ paid_periods: 3 });
  });
});
