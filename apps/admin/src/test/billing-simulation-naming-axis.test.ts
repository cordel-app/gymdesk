import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { MONTH_TICK_MS, monthTickLabel } from '../lib/monthAxis';
import * as paymentsView from '../app/[locale]/members/paymentsTimelineView';
import { billingDateToX } from '../lib/billingEventSimulation';

// #3506 — the two Billing simulations of a Membership Plan: their names, and a month/year x axis
// that is the Payments tab chart's own.

const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
const locale = (l: string) => JSON.parse(readFileSync(join(__dirname, '..', '..', 'locales', 'base', `${l}.json`), 'utf8'));

describe('month/year x axis (#3506)', () => {
  it('labels a billing date by its month and year, in the gym’s date format', () => {
    const x = billingDateToX('2026-11-27')!;
    expect(monthTickLabel(x, { date_format: 'DD/MM/YYYY' })).toBe('11/2026');
    expect(monthTickLabel(x, { date_format: 'YYYY-MM-DD' })).toBe('2026-11');
  });

  it('is the Payments tab chart’s own formatter, not a copy', () => {
    expect(paymentsView.monthTickLabel).toBe(monthTickLabel);
    expect(paymentsView.MONTH_TICK_MS).toBe(MONTH_TICK_MS);
  });

  it('is what the shared simulation chart draws (Membership Plan and Assigned Plan alike)', () => {
    const chart = src('components/BillingEventSimulationChart.tsx');
    expect(chart).toContain('axisLabelFormatter={(x) => monthTickLabel(x, gym)}');
    expect(chart).toContain('xMinInterval={MONTH_TICK_MS}');
  });
});

describe('simulation section names (#3506)', () => {
  const expected: Record<string, [string, string]> = {
    en: ['Billing - Plan Simulation', 'Billing - Plan and Products Simulation'],
    es: ['Facturación - Simulación del plan', 'Facturación - Simulación del plan y productos'],
    ca: ['Facturació - Simulació del pla', 'Facturació - Simulació del pla i productes'],
  };
  for (const [l, [plan, both]] of Object.entries(expected)) {
    it(`names both sections in ${l}`, () => {
      const d = locale(l);
      expect(d.assigned_plans_page.section_billing_forecast).toBe(plan);
      expect(d.assigned_plans_page.section_billing_event_simulation).toBe(both);
      expect(d.members.section_billing_event_simulation).toBe(both);
    });
  }

  it('the Assigned Plan card (both of its hosts) titles its forecast with that one key', () => {
    expect(src('components/assignedPlan/AssignedPlanExpandedRow.tsx'))
      .toContain("<CardSection label={t('section_billing_forecast')}>");
  });
});
