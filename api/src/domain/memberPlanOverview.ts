// #2426 — what the Members App's **Add Plan** card says about a Membership Plan
// before the member chooses it: Billing & Duration, every Product the plan
// carries with its regular and final price, the pre-paid commitment end date,
// the Initial Payment and the two-cycle Billing Event Simulation.
//
// This module decides NOTHING about money. The plan's enriched read
// (`enrichPlan()` in `api/src/api/membership-plans.ts`) already holds the
// engine's output — the benefit rows with their `applyLineBenefit()` prices and
// the Billing Event Simulation over `computeBillingSimulation()` — and this is
// only the member-facing re-shaping of it. The Initial Payment is the
// simulation's own first date, so it cannot differ from the first billing
// event the simulation lists. The only date it computes is the pre-paid
// commitment end, by `advanceBillingDate()`, the step the nightly run takes.
//
// Pure — no DB, no HTTP.

import { advanceBillingDate, type BillingDateUnit } from './billingDate';
import type { BillingEventDate } from './billingEventSimulation';

export interface MemberPlanOverviewProduct {
  section: 'session' | 'oneoff' | 'periodical';
  product_id: number;
  name: string;
  quantity: number;
  /** The Product's billing frequency, or a Session Benefit's renewal frequency. */
  frequency: string | null;
  mandatory: boolean;
  action: string | null;
  value: number | null;
  original_price_incl_tax: number | null;
  final_price_incl_tax: number | null;
  original_line_price_incl_tax: number | null;
  final_line_price_incl_tax: number | null;
}

export interface MemberPlanOverview {
  billing_duration: {
    free_periods: number;
    paid_periods: number;
    prepaid_periods: number;
    bonus_periods: number;
    billing_interval: number | null;
    billing_unit: string | null;
    auto_renew: boolean;
  };
  products: MemberPlanOverviewProduct[];
  /** Last day of the pre-paid commitment, or `null` when the plan has none. */
  prepaid_end_date: string | null;
  /** The first billing event's total, or `null` when nothing can be simulated. */
  initial_payment: number | null;
  simulation: {
    available: boolean;
    tax_included: boolean;
    dates: BillingEventDate[];
  };
}

const num = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const numOrNull = (v: unknown): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * The last day of the pre-paid commitment: the plan's start advanced by the
 * Free Period plus the Pre-paid Duration, in the plan's own Billing frequency,
 * minus a day (the period after the last pre-paid one is the first that
 * charges). `null` when the plan pre-pays nothing or has no cadence — no
 * artificial date is invented.
 */
export function prepaidEndDate(
  startsAt: string, freePeriods: number, prepaidPeriods: number,
  cadence: { interval: number; unit: BillingDateUnit } | null,
): string | null {
  if (!cadence || prepaidPeriods <= 0 || !(cadence.interval > 0)) return null;
  const covered = (Math.max(0, freePeriods) + prepaidPeriods) * cadence.interval;
  const next = advanceBillingDate(startsAt, covered, cadence.unit);
  const d = new Date(`${next}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export function buildMemberPlanOverview(enriched: any, startsAt: string): MemberPlanOverview {
  const policy = enriched.billing_policy ?? null;
  const interval = policy ? numOrNull(policy.recurring_billing_interval) : null;
  const unit = policy ? (policy.recurring_billing_unit as string | null) : null;
  const free = num(enriched.free_periods);
  const prepaid = num(enriched.pay_beforehand_periods);

  const sections: Array<[MemberPlanOverviewProduct['section'], any[]]> = [
    ['oneoff', enriched.oneoff_benefits ?? []],
    ['session', enriched.session_benefits ?? []],
    ['periodical', enriched.periodical_benefits ?? []],
  ];
  const products: MemberPlanOverviewProduct[] = [];
  for (const [section, rows] of sections) {
    for (const r of rows) {
      products.push({
        section,
        product_id: num(r.product_id),
        name: String(r.product_name ?? ''),
        quantity: num(r.quantity, 1),
        frequency: (section === 'session' ? r.frequency : r.product_billing_frequency) ?? null,
        mandatory: r.mandatory === undefined ? true : Boolean(Number(r.mandatory)) || r.mandatory === true,
        action: r.action ?? null,
        value: numOrNull(r.value),
        original_price_incl_tax: numOrNull(r.original_price_incl_tax),
        final_price_incl_tax: numOrNull(r.final_price_incl_tax),
        original_line_price_incl_tax: numOrNull(r.original_line_price_incl_tax),
        final_line_price_incl_tax: numOrNull(r.final_line_price_incl_tax),
      });
    }
  }

  const sim = enriched.billing_event_simulation ?? { available: false, tax_included: false, dates: [] };
  const dates: BillingEventDate[] = Array.isArray(sim.dates) ? sim.dates : [];
  return {
    billing_duration: {
      free_periods: free,
      paid_periods: num(enriched.paid_periods),
      prepaid_periods: prepaid,
      bonus_periods: num(enriched.bonus_periods),
      billing_interval: interval,
      billing_unit: unit,
      auto_renew: policy ? Boolean(Number(policy.auto_renew)) : false,
    },
    products,
    prepaid_end_date: prepaidEndDate(
      startsAt, free, prepaid,
      interval != null && unit ? { interval, unit: unit as BillingDateUnit } : null,
    ),
    initial_payment: sim.available && dates[0] ? num(dates[0].total) : null,
    simulation: { available: Boolean(sim.available), tax_included: Boolean(sim.tax_included), dates },
  };
}
