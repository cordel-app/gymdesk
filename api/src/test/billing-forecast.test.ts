// Unit tests for computeBillingForecast / applyChargeBenefit — pure functions,
// no DB dependency. #485.

import { describe, expect, it } from 'vitest';
import { applyChargeBenefit, computeBillingForecast } from '../domain/billingForecast';

describe('applyChargeBenefit', () => {
  it('zeroes out the amount for a waive benefit', () => {
    expect(applyChargeBenefit(40, 'waive', null)).toBe(0);
  });

  it('applies a percentage discount', () => {
    expect(applyChargeBenefit(40, 'percentage_discount', 50)).toBe(20);
  });

  it('applies a fixed discount', () => {
    expect(applyChargeBenefit(40, 'fixed_discount', 15)).toBe(25);
  });

  it('clamps a fixed discount larger than the amount at 0', () => {
    expect(applyChargeBenefit(10, 'fixed_discount', 25)).toBe(0);
  });

  it('passes the amount through unchanged for no_benefit', () => {
    expect(applyChargeBenefit(40, 'no_benefit', null)).toBe(40);
  });
});

describe('computeBillingForecast', () => {
  it('reports unavailable when price is missing', () => {
    const result = computeBillingForecast({
      planName: 'Standard',
      price: null,
      recurringBillingInterval: 1,
      recurringBillingUnit: 'month',
      benefitLines: [],
    });
    expect(result.available).toBe(false);
    expect(result.events).toEqual([]);
    expect(result.reason).toBeTruthy();
  });

  it('reports unavailable when billing frequency is missing', () => {
    const result = computeBillingForecast({
      planName: 'Standard',
      price: 60,
      recurringBillingInterval: null,
      recurringBillingUnit: null,
      benefitLines: [],
    });
    expect(result.available).toBe(false);
  });

  it('returns exactly the next 10 events for monthly billing', () => {
    const result = computeBillingForecast({
      planName: 'Standard',
      price: 60,
      recurringBillingInterval: 1,
      recurringBillingUnit: 'month',
      benefitLines: [],
      anchorDate: '2026-09-01',
    });
    expect(result.available).toBe(true);
    expect(result.events).toHaveLength(10);
    expect(result.events[0].date).toBe('2026-10-01');
    expect(result.events[1].date).toBe('2026-11-01');
    expect(result.events[0].total).toBe(60);
    expect(result.events[0].lines).toEqual([{ label: 'Standard', amount: 60 }]);
  });

  it('advances by 28 days for a 4-week billing frequency (never treated as a month)', () => {
    const result = computeBillingForecast({
      planName: 'Standard',
      price: 60,
      recurringBillingInterval: 4,
      recurringBillingUnit: 'week',
      benefitLines: [],
      anchorDate: '2026-01-10',
    });
    expect(result.events[0].date).toBe('2026-02-07');
  });

  it('uses the current price for every projected event and changing it changes all of them', () => {
    const cheap = computeBillingForecast({
      planName: 'Standard', price: 60, recurringBillingInterval: 1, recurringBillingUnit: 'month',
      benefitLines: [], anchorDate: '2026-09-01',
    });
    const expensive = computeBillingForecast({
      planName: 'Standard', price: 75, recurringBillingInterval: 1, recurringBillingUnit: 'month',
      benefitLines: [], anchorDate: '2026-09-01',
    });
    expect(cheap.events.every(e => e.total === 60)).toBe(true);
    expect(expensive.events.every(e => e.total === 75)).toBe(true);
  });

  it('includes waive and percentage-discount benefit lines with correct totals', () => {
    const result = computeBillingForecast({
      planName: 'Standard',
      price: 60,
      recurringBillingInterval: 1,
      recurringBillingUnit: 'month',
      benefitLines: [
        { label: 'Locker', amount: 10, action: 'waive', value: null },
        { label: 'Parking', amount: 40, action: 'percentage_discount', value: 50 },
      ],
      anchorDate: '2026-09-01',
    });
    const [event] = result.events;
    expect(event.lines).toEqual([
      { label: 'Standard', amount: 60 },
      { label: 'Locker', amount: 0, benefit: { action: 'waive', value: null } },
      { label: 'Parking', amount: 20, benefit: { action: 'percentage_discount', value: 50 } },
    ]);
    expect(event.total).toBe(80);
  });

  it('excludes no_benefit charge lines entirely', () => {
    const result = computeBillingForecast({
      planName: 'Standard',
      price: 60,
      recurringBillingInterval: 1,
      recurringBillingUnit: 'month',
      benefitLines: [{ label: 'Insurance', amount: 5, action: 'no_benefit', value: null }],
      anchorDate: '2026-09-01',
    });
    expect(result.events[0].lines).toEqual([{ label: 'Standard', amount: 60 }]);
  });

  it('does not apply promotions — the forecast has no concept of them', () => {
    const result = computeBillingForecast({
      planName: 'Standard',
      price: 60,
      recurringBillingInterval: 1,
      recurringBillingUnit: 'month',
      benefitLines: [],
      anchorDate: '2026-09-01',
    });
    expect(result.events[0].total).toBe(60);
  });
});
