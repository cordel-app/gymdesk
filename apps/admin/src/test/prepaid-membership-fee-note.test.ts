import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  PlanSimulationLine,
  formatPlanTimelineBilling,
  planSimulationPriceLabelKey,
} from '@/app/[locale]/plans/planProfile';

// #946 — a Plan's Pre-paid Duration is collected in one charge on the first of
// its periods, so the Membership Fee line of that billing event is the fee times
// the periods it covers and must not read "Waived".
//
// apps/admin has no component-test infra (docs/architecture.md's TL;DR), so the
// rendering is pinned by scanning the sources the way the other simulation tests
// do, while the pure declarations are exercised directly. What a future edit
// could break silently is the two halves of the same rule: the note is the
// server's field (never inferred from a quantity) and the amount is the
// server's (never multiplied here).

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const COMPONENT = join(__dirname, '..', 'components', 'BillingEventSimulation.tsx');
const MEMBER_SIMULATION = join(__dirname, '..', 'app', '[locale]', 'members', 'MemberBillingSimulation.tsx');
const PLANS_PAGE = join(__dirname, '..', 'app', '[locale]', 'plans', 'page.tsx');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

const read = (p: string) => readFileSync(p, 'utf-8');
const locales = Object.fromEntries(
  LOCALE_CODES.map((code) => [code, JSON.parse(read(join(LOCALES_DIR, `${code}.json`)))]),
) as Record<(typeof LOCALE_CODES)[number], any>;

const line = (over: Partial<PlanSimulationLine> = {}): PlanSimulationLine => ({
  kind: 'membership_fee',
  label: 'Full Access',
  gym_charge_id: null,
  mandatory: false,
  quantity: 3,
  unit_price: 70,
  regular_price: 210,
  actual_charge: 210,
  prepaid_periods: 3,
  benefits: [],
  ...over,
});

describe('Billing Event Simulation: a prepaid Membership Fee', () => {
  it('reads as the regular price, never as Waived', () => {
    // The server sends no benefit for that line precisely so this is true: a
    // prepaid charge is a real payment for the periods it covers.
    expect(line().benefits).toEqual([]);
    expect(planSimulationPriceLabelKey(undefined)).toBe('simulation_price_regular');
  });

  it('is noted from the server\'s own field, not inferred from the quantity', () => {
    const src = read(COMPONENT);
    expect(src).toContain('line.prepaid_periods != null');
    expect(src).toContain("t('simulation_prepaid_periods'");
    // No arithmetic on the amounts in the page (#817, #915).
    expect(src).not.toMatch(/line\.(unit_price|regular_price|actual_charge)\s*[*+/-]/);
  });

  it('is noted on the Member card\'s own Billing Simulation too', () => {
    const src = read(MEMBER_SIMULATION);
    expect(src).toContain('line.prepaid_periods != null');
    expect(src).toContain("t('billing_simulation_prepaid_periods'");
  });

  it('names the periods its amount covers in the Example Timeline cell', () => {
    expect(formatPlanTimelineBilling(
      { amount: 210, waived: false }, 'No charge', 'VAT included', '3 periods prepaid',
    )).toBe('€210.00 VAT included · 3 periods prepaid');
    // Every other row is unchanged — no note, and a waived one still says so.
    expect(formatPlanTimelineBilling({ amount: 70, waived: false }, 'No charge', 'VAT included', null))
      .toBe('€70.00 VAT included');
    expect(formatPlanTimelineBilling({ amount: null, waived: true }, 'No charge', 'VAT included', null))
      .toBe('No charge');
    // And the page passes the server's count rather than deciding one.
    expect(read(PLANS_PAGE)).toContain('row.prepaidPeriods != null');
  });

  it('has its label in every namespace that renders the section, in all three locales', () => {
    for (const code of LOCALE_CODES) {
      // The shared component resolves the key in the calling page's namespace
      // (#901), so a Promotion card rendering it must find the key too.
      for (const ns of ['plans', 'promotions'] as const) {
        const value = locales[code][ns].simulation_prepaid_periods;
        expect(value, `${ns}.simulation_prepaid_periods missing from ${code}.json`).toBeTruthy();
        expect(value).toContain('plural');
      }
      expect(locales[code].plans.timeline_prepaid_periods).toContain('plural');
      expect(locales[code].members.billing_simulation_prepaid_periods).toContain('plural');
    }
  });
});
