// #2940 — the Billing Event naming rule (`domain/billingEventName.ts`), every branch.
import { describe, expect, it } from 'vitest';
import {
  INITIAL_ENGAGEMENT_NAME, initialEventName, purchaseEventName, recurringEventName,
} from '../domain/billingEventName';

const month = { interval: 1, unit: 'month' };
const fourWeeks = { interval: 4, unit: 'week' };

describe('recurringEventName', () => {
  it('names a monthly charge on the 1st by its month alone', () => {
    expect(recurringEventName({ gymName: 'Gym', billingDate: '2027-01-01', cadence: month })).toBe('Gym - January');
    expect(recurringEventName({ gymName: 'Gym', billingDate: '2027-03-01', cadence: month })).toBe('Gym - March');
  });

  it('names a 4-week charge by the month and the billing date', () => {
    expect(recurringEventName({ gymName: 'Gym', billingDate: '2027-01-01', cadence: fourWeeks })).toBe('Gym - January (01/01/2027)');
    expect(recurringEventName({ gymName: 'Gym', billingDate: '2027-01-29', cadence: fourWeeks })).toBe('Gym - January (29/01/2027)');
  });

  it('carries the date for a monthly charge on another day and for a charge with no schedule', () => {
    expect(recurringEventName({ gymName: 'Gym', billingDate: '2027-02-15', cadence: month })).toBe('Gym - February (15/02/2027)');
    expect(recurringEventName({ gymName: 'Gym', billingDate: '2027-12-01', cadence: null })).toBe('Gym - December (01/12/2027)');
  });
});

describe('purchaseEventName', () => {
  it('names one product or one plan by itself, anything more as a purchase on its date', () => {
    expect(purchaseEventName({ gymName: 'Gym', purchaseDate: '2026-11-16', items: { plans: [], products: ['Boxing Gloves'] } }))
      .toBe('Gym - Boxing Gloves');
    expect(purchaseEventName({ gymName: 'Gym', purchaseDate: '2026-11-16', items: { plans: ['Premium'], products: [] } }))
      .toBe('Gym - Premium');
    expect(purchaseEventName({ gymName: 'Gym', purchaseDate: '2026-11-16', items: { plans: ['Premium'], products: ['Gloves'] } }))
      .toBe('Gym - Compra 16/11/2026');
    expect(purchaseEventName({ gymName: 'Gym', purchaseDate: '2026-11-16', items: { plans: [], products: ['A', 'B'] } }))
      .toBe('Gym - Compra 16/11/2026');
  });

  it('never exceeds the column width', () => {
    const long = 'x'.repeat(400);
    expect(purchaseEventName({ gymName: 'Gym', purchaseDate: '2026-11-16', items: { plans: [], products: [long] } })).toHaveLength(255);
  });
});

describe('initialEventName', () => {
  const base = { gymName: 'Gym', purchaseDate: '2026-11-16', firstEngagement: false, modifiesPlan: false };

  it('is Initial Engagement for a first engagement or a plan modification, whatever was added', () => {
    expect(initialEventName({ ...base, firstEngagement: true, added: { plans: ['Premium'], products: [] } })).toBe(INITIAL_ENGAGEMENT_NAME);
    expect(initialEventName({ ...base, modifiesPlan: true, added: { plans: [], products: ['Gloves'] } })).toBe(INITIAL_ENGAGEMENT_NAME);
  });

  it('otherwise names the purchase from what was added', () => {
    expect(initialEventName({ ...base, added: { plans: [], products: ['Gloves'] } })).toBe('Gym - Gloves');
    expect(initialEventName({ ...base, added: { plans: ['Premium'], products: [] } })).toBe('Gym - Premium');
    expect(initialEventName({ ...base, added: { plans: ['A'], products: ['B'] } })).toBe('Gym - Compra 16/11/2026');
  });

  it('treats a change that adds nothing nameable as a modification', () => {
    expect(initialEventName({ ...base, added: { plans: [], products: [] } })).toBe(INITIAL_ENGAGEMENT_NAME);
  });
});
