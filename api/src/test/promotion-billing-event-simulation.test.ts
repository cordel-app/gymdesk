// Unit tests for `computePromotionBillingEventSimulation` (#922) — a pure
// projection over the Billing Simulation engine, so no DB, no HTTP and no test
// gym (CLAUDE.md: unit tests vs integration tests).
//
// The ticket's load-bearing rules are each asserted here: only the events the
// Promotion affects are shown, they are grouped by their actual billing date,
// different frequencies stay independent (and coincide into one group when
// their dates do), a `Once` item appears once, `Waive` gives a Final Price of
// €0 while the line is still shown, the per-date total is the sum of the final
// prices, and the projection spans two complete cycles of every recurring
// frequency present.

import { describe, expect, it } from 'vitest';
import {
  PromotionSimulationGrant,
  computePromotionBillingEventSimulation,
} from '../domain/promotionBillingEventSimulation';
import { NO_PRODUCT_BENEFIT } from '../domain/productBenefitActions';

const ANCHOR = '2026-09-30';
const WAIVE = { action: 'waive' as const, value: null };

function grant(over: Partial<PromotionSimulationGrant> = {}): PromotionSimulationGrant {
  return {
    productId: 1,
    name: 'Insurance Fee',
    category: 'periodical',
    billingFrequency: 'month',
    unitPriceInclTax: 20,
    quantity: 3,
    benefit: WAIVE,
    ...over,
  };
}

function simulate(grants: PromotionSimulationGrant[], over: {
  anchorDate?: string;
  startsAt?: string | null;
  maxMonths?: number;
} = {}) {
  return computePromotionBillingEventSimulation({
    promotionName: 'Autumn Offer',
    startsAt: over.startsAt ?? null,
    freeMonths: 0,
    paidMonths: 12,
    payBeforehandMonths: 0,
    bonusMonths: 0,
    grants,
    anchorDate: 'anchorDate' in over ? over.anchorDate : ANCHOR,
    maxMonths: over.maxMonths,
  });
}

type Result = ReturnType<typeof simulate>;
const dates = (r: Result) => r.dates.map((g) => g.date);
const group = (r: Result, date: string) => r.dates.find((g) => g.date === date)!;
const labels = (r: Result, date: string) => group(r, date).lines.map((l) => l.label);

describe('computePromotionBillingEventSimulation', () => {
  it('is unavailable, with a reason, for a Promotion that grants nothing', () => {
    const result = simulate([]);
    expect(result.available).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(result.dates).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('is unavailable when no grant has a billable frequency', () => {
    // A periodical grant whose Product carries no frequency has no
    // schedule to project, so there is nothing to show.
    const result = simulate([grant({ billingFrequency: null })]);
    expect(result.available).toBe(false);
    expect(result.dates).toEqual([]);
  });

  // The ticket's own example: a monthly €20 Insurance Fee, waived.
  it('shows the waived line at €0 on every billing date, with its regular price', () => {
    const result = simulate([grant()]);
    expect(result.available).toBe(true);
    expect(result.tax_included).toBe(true);
    expect(result.anchor_date).toBe(ANCHOR);
    expect(dates(result).slice(0, 3)).toEqual(['2026-09-30', '2026-10-30', '2026-11-30']);
    for (const date of dates(result).slice(0, 3)) {
      const [line] = group(result, date).lines;
      expect(line.label).toBe('Insurance Fee');
      expect(line.regular_price).toBe(20);
      expect(line.actual_charge).toBe(0);
      expect(line.benefits.map((b) => b.action)).toEqual(['waive']);
      expect(group(result, date).total).toBe(0);
    }
  });

  it('names the Promotion on the line it discounts', () => {
    const result = simulate([grant({ benefit: { action: 'percentage_discount', value: 20 } })]);
    const [line] = group(result, ANCHOR).lines;
    expect(line.actual_charge).toBe(16);
    expect(line.benefits[0]).toMatchObject({ source: 'promotion', name: 'Autumn Offer' });
  });

  // "No applicable promotion → Final Price = Regular Price": the periods beyond
  // what the grant covers are still the Promotion's own billing events, and they
  // are charged in full.
  it('charges the regular price once the granted periods run out', () => {
    const result = simulate([grant({ quantity: 2 })]);
    expect(group(result, '2026-09-30').total).toBe(0);
    expect(group(result, '2026-10-30').total).toBe(0);
    expect(group(result, '2026-11-30').total).toBe(20);
    expect(group(result, '2026-11-30').lines[0].benefits).toEqual([]);
  });

  it('spans two complete cycles of every recurring frequency present', () => {
    // A yearly grant stretches the projection to two years and drags the
    // monthly one along with it — the length is derived from the frequencies
    // present, never from a fixed month count.
    const result = simulate([
      grant({ productId: 1, name: 'Insurance Fee', billingFrequency: 'month', quantity: 3 }),
      grant({ productId: 2, name: 'Annual Pass', billingFrequency: 'year', quantity: 1 }),
    ]);
    expect(result.horizon_date).toBe('2028-09-30');
    expect(result.truncated).toBe(false);
    // Three yearly charges (an event lands on the horizon itself) and the
    // monthly stream carried all the way out with them.
    const yearly = result.dates.filter((g) => g.lines.some((l) => l.label === 'Annual Pass'));
    expect(yearly.map((g) => g.date)).toEqual(['2026-09-30', '2027-09-30', '2028-09-30']);
    const monthly = result.dates.filter((g) => g.lines.some((l) => l.label === 'Insurance Fee'));
    expect(monthly.length).toBe(24);
    expect(labels(result, '2026-09-30')).toEqual(['Annual Pass', 'Insurance Fee']);
  });

  it('keeps frequencies independent and groups only the dates that coincide', () => {
    const result = simulate([
      grant({ productId: 1, name: 'Insurance Fee', billingFrequency: 'month', quantity: 3 }),
      grant({ productId: 2, name: 'Locker Rental', billingFrequency: 'four_weeks', quantity: 3 }),
    ]);
    // Both start on the anchor, then diverge: 28 days vs one calendar month.
    expect(labels(result, '2026-09-30').sort()).toEqual(['Insurance Fee', 'Locker Rental']);
    expect(labels(result, '2026-10-28')).toEqual(['Locker Rental']);
    expect(labels(result, '2026-10-30')).toEqual(['Insurance Fee']);
  });

  it('bills a One-off or Session grant exactly once, for its whole quantity', () => {
    const result = simulate([
      grant({
        productId: 3, name: 'Registration Fee', category: 'oneoff',
        billingFrequency: 'once', unitPriceInclTax: 100, quantity: 1,
        benefit: { action: 'percentage_discount', value: 20 },
      }),
      grant({
        productId: 4, name: 'Personal Training', category: 'session',
        billingFrequency: 'per_session', unitPriceInclTax: 25, quantity: 2,
      }),
    ]);
    expect(dates(result)).toEqual([ANCHOR]);
    const [oneoff, session] = group(result, ANCHOR).lines;
    expect(oneoff.label).toBe('Registration Fee');
    expect(oneoff.actual_charge).toBe(80);
    expect(session.label).toBe('Personal Training');
    expect(session.quantity).toBe(2);
    expect(session.actual_charge).toBe(0);
  });

  it("totals each date from its lines' final prices", () => {
    const result = simulate([
      grant({ productId: 1, name: 'Insurance Fee', unitPriceInclTax: 20, benefit: WAIVE }),
      grant({
        productId: 2, name: 'Locker Rental', unitPriceInclTax: 15,
        benefit: { action: 'percentage_discount', value: 20 },
      }),
      grant({
        productId: 3, name: 'Registration Fee', category: 'oneoff', billingFrequency: 'once',
        unitPriceInclTax: 100, quantity: 1, benefit: { action: 'fixed_discount', value: 20 },
      }),
    ]);
    // 80 (registration) + 0 (insurance) + 12 (locker) = 92, the ticket's example.
    expect(group(result, ANCHOR).total).toBe(92);
    expect(result.total).toBe(
      result.dates.reduce((sum, g) => sum + g.total, 0),
    );
  });

  it('flags no line as Mandatory — that is a Membership Plan question', () => {
    const result = simulate([grant()]);
    expect(group(result, ANCHOR).lines.every((l) => l.mandatory === false)).toBe(true);
  });

  it('never projects a Membership Fee: a Promotion carries no price of its own', () => {
    const result = simulate([grant()]);
    const kinds = new Set(result.dates.flatMap((g) => g.lines.map((l) => l.kind)));
    expect([...kinds]).toEqual(['product']);
  });

  it('anchors a Promotion that has not started yet on its own start date', () => {
    const startsAt = '2099-01-15';
    const result = simulate([grant()], { anchorDate: undefined, startsAt });
    expect(result.anchor_date).toBe(startsAt);
    expect(dates(result)[0]).toBe(startsAt);
  });

  it('anchors a Promotion already under way on today', () => {
    const today = new Date().toISOString().slice(0, 10);
    const result = simulate([grant()], { anchorDate: undefined, startsAt: '2020-01-01' });
    expect(result.anchor_date).toBe(today);
  });

  it('prices an item with no treatment configured at its regular price', () => {
    const result = simulate([grant({ benefit: NO_PRODUCT_BENEFIT })]);
    const [line] = group(result, ANCHOR).lines;
    expect(line.actual_charge).toBe(20);
    expect(line.regular_price).toBe(20);
    expect(line.benefits).toEqual([]);
  });
});
