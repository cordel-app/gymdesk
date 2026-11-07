import { describe, it, expect } from 'vitest';
import { buildMemberPlanOverview, prepaidEndDate } from '../domain/memberPlanOverview';

describe('prepaidEndDate (#2426)', () => {
  const monthly = { interval: 1, unit: 'month' as const };
  it('is the day before the first charging period', () => {
    expect(prepaidEndDate('2026-11-07', 1, 3, monthly)).toBe('2027-03-06');
  });
  it('is null when nothing is pre-paid or there is no cadence', () => {
    expect(prepaidEndDate('2026-11-07', 1, 0, monthly)).toBeNull();
    expect(prepaidEndDate('2026-11-07', 0, 3, null)).toBeNull();
  });
  it('steps by the plan cadence (4 weeks)', () => {
    expect(prepaidEndDate('2026-11-07', 0, 2, { interval: 4, unit: 'week' })).toBe('2027-01-01');
  });
});

describe('buildMemberPlanOverview (#2426)', () => {
  const enriched = {
    free_periods: 1, paid_periods: 6, bonus_periods: 1, pay_beforehand_periods: 2,
    billing_policy: { recurring_billing_interval: 1, recurring_billing_unit: 'month', auto_renew: 1 },
    oneoff_benefits: [{ product_id: 3, product_name: 'Towel', quantity: 1, mandatory: 0, action: 'waive', value: null,
      product_billing_frequency: 'once', original_price_incl_tax: 10, final_price_incl_tax: 0,
      original_line_price_incl_tax: 10, final_line_price_incl_tax: 0 }],
    session_benefits: [], periodical_benefits: [],
    billing_event_simulation: { available: true, tax_included: true, dates: [{ date: '2026-11-07', total: 42.5, lines: [], cycle: 1 }, { date: '2026-12-07', total: 30, lines: [], cycle: 1 }] },
  };
  it('reports the plan as configured and takes the initial payment from the first simulated event', () => {
    const o = buildMemberPlanOverview(enriched, '2026-11-07');
    expect(o.billing_duration).toMatchObject({ free_periods: 1, paid_periods: 6, prepaid_periods: 2, bonus_periods: 1, auto_renew: true });
    expect(o.initial_payment).toBe(42.5);
    expect(o.products[0]).toMatchObject({ name: 'Towel', mandatory: false, final_price_incl_tax: 0, original_price_incl_tax: 10 });
    expect(o.prepaid_end_date).toBe('2027-02-06');
  });
  it('has no initial payment or pre-paid date when unavailable', () => {
    const o = buildMemberPlanOverview({ billing_event_simulation: { available: false, dates: [] } }, '2026-11-07');
    expect(o.initial_payment).toBeNull();
    expect(o.prepaid_end_date).toBeNull();
    expect(o.billing_duration.auto_renew).toBe(false);
  });
});
