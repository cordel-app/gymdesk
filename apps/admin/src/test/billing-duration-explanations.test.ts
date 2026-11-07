import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  billingDurationExplanations,
  cadenceAlignmentKey,
} from '@/lib/billingDurationExplanations';

// #2470 — which Billing & Duration parameters are explained, and the shared
// layout of the Billing Event Simulation section.

const none = {
  free_periods: null, paid_periods: null, pay_beforehand_periods: null, bonus_periods: null,
  recurring_billing_interval: null, recurring_billing_unit: null,
};

describe('billingDurationExplanations', () => {
  it('explains nothing for an unconfigured plan', () => {
    expect(billingDurationExplanations(none)).toEqual([]);
  });

  it('explains only the configured parameters, in the summary order', () => {
    const keys = billingDurationExplanations({
      free_periods: 1, paid_periods: 6, pay_beforehand_periods: 2, bonus_periods: 0,
      recurring_billing_interval: 1, recurring_billing_unit: 'month', auto_renew: true,
    }).map((e) => e.key);
    expect(keys).toEqual(['free_periods', 'paid_periods', 'pay_beforehand_periods', 'billing_frequency', 'auto_renew']);
  });

  it('words the alignment rule of each cadence and the auto-renew state', () => {
    expect(cadenceAlignmentKey(1, 'month')).toBe('month');
    expect(cadenceAlignmentKey(4, 'week')).toBe('four_weeks');
    expect(cadenceAlignmentKey(1, 'week')).toBe('week');
    expect(cadenceAlignmentKey(1, 'year')).toBe('year');
    expect(cadenceAlignmentKey(2, 'month')).toBeNull();
    const off = billingDurationExplanations({ ...none, auto_renew: false });
    expect(off[0].textKey).toBe('auto_renew_off');
  });

  it('has every key in every locale', () => {
    const keys = [
      'label_free', 'label_paid', 'label_prepaid', 'label_bonus', 'label_frequency', 'label_auto_renew',
      'free', 'paid', 'prepaid', 'bonus', 'alignment_month', 'alignment_four_weeks', 'alignment_week',
      'alignment_year', 'alignment_other', 'auto_renew_on', 'auto_renew_off',
    ];
    for (const loc of ['en', 'es', 'ca']) {
      const d = JSON.parse(readFileSync(join(__dirname, '..', '..', 'locales', 'base', `${loc}.json`), 'utf8'));
      for (const k of keys) expect(d.billing_duration_help[k], `${loc}.${k}`).toBeTruthy();
      expect(d.plans.section_billing_simulation_details).toBeTruthy();
      expect(d.assigned_plans_page.section_billing_simulation_details).toBeTruthy();
    }
  });
});

describe('shared simulation layout', () => {
  const src = (f: string) => readFileSync(join(__dirname, '..', f), 'utf8');
  it('all three hosts render the shared panel', () => {
    for (const f of [
      'app/[locale]/plans/page.tsx',
      'components/assignedPlan/AssignedPlanExpandedRow.tsx',
      'app/[locale]/members/MemberProductSet.tsx',
    ]) expect(src(f), f).toContain('<BillingEventSimulationPanel');
  });
  it('the panel puts the chart before the details, collapsed by default', () => {
    const p = src('components/BillingEventSimulationPanel.tsx');
    expect(p.indexOf('<BillingEventSimulationChart')).toBeLessThan(p.indexOf('<BillingEventSimulation\n'));
    expect(p).toContain('useState(false)');
  });
});
