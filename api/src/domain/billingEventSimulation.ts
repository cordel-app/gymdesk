// The shape every **Billing Event Simulation** reports, and the one re-grouping
// that produces it: one group per billing *date*, listing every line that falls
// on it.
//
// #915 built this for the Membership Plan card as a thin adapter over
// `domain/billingSimulation.ts`. #922 asks for the same projection on the
// Promotion card, with the ticket's own load-bearing clause:
//
//   > Ideally, the two simulations should share the same underlying simulation
//   > engine rather than implementing two independent versions. The only
//   > difference should be the input/context.
//
// So the parts that are not the context live here — the result types, the
// horizon floor and the date grouping — and each caller is only the adapter
// that expresses its entity as the hypothetical assignment the engine prices:
//
//   * `planBillingEventSimulation.ts` — the Plan a member enrolls on today:
//     its Membership Fee plus every Sellable Item it carries.
//   * `promotionBillingEventSimulation.ts` — the Promotion applied to that
//     member today: the Sellable Items it grants, at the price its own
//     `(action, value)` pair gives them.
//
// Nothing here decides a date, an amount or a period status: that is the
// engine's (`computeBillingSimulation()`, `applyLineBenefit()`,
// `advanceBillingDate()`, `classifyPlanDurationPeriod()`). Nothing is persisted
// and nothing is charged.

import { BillingSimulationResult, SimulationBenefit } from './billingSimulation';

/**
 * How many complete cycles of every recurring billing frequency a simulation
 * spans. Two, per #915 and #922 alike ("two complete cycles of all recurring
 * billing events"), so a yearly item stretches the projection to two years and
 * drags the 4-weekly ones along with it: the length is derived from the
 * frequencies present rather than being a fixed number of months.
 *
 * Because an event lands on the horizon itself, the fastest stream shows three
 * charges — the Sep 30 / Oct 28 / Nov 25 shape both tickets' examples have.
 */
export const SIMULATED_CYCLES = 2;

/** One line of one billing event. The money fields are the engine's, verbatim. */
export interface BillingEventLine {
  kind: 'membership_fee' | 'sellable_item';
  label: string;
  gym_charge_id: number | null;
  /** True when this line exists because the Sellable Item is Mandatory (#832). */
  mandatory: boolean;
  quantity: number;
  unit_price: number;
  /** Before the configured treatment — what both tickets call "Regular price". */
  regular_price: number;
  /** After it. `0` for a waived line, which is still shown as a €0 event. */
  actual_charge: number;
  /**
   * #946 — how many Pre-paid periods this line covers. Set only on the
   * Membership Fee charge that collects a Plan's Pre-paid Duration up front, so
   * the card can say "3 periods prepaid" beside an amount that is the fee times
   * that count; `null` on every other line.
   */
  prepaid_periods: number | null;
  /** Why `actual_charge` differs from `regular_price`; empty at the regular price. */
  benefits: SimulationBenefit[];
}

/** Every line that falls on one billing date, and what that date costs. */
export interface BillingEventDate {
  date: string;
  lines: BillingEventLine[];
  total: number;
}

export interface BillingEventSimulationResult {
  available: boolean;
  /** Why there is nothing to simulate, for the caller to render in its own words. */
  reason: string | null;
  currency: 'EUR';
  /** The hypothetical enrollment date the dates were counted from. */
  anchor_date: string | null;
  /** The last date the projection runs to. */
  horizon_date: string | null;
  /** The amounts are gross — every adapter denominates the engine in VAT-inclusive euros. */
  tax_included: boolean;
  /** True when the engine's safety cap was reached before the horizon rule was met. */
  truncated: boolean;
  dates: BillingEventDate[];
  total: number;
}

export const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Today, UTC, as the `YYYY-MM-DD` string every date in these projections is. */
export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export const emptyBillingEventSimulation = (
  reason: string | null,
): BillingEventSimulationResult => ({
  available: false, reason, currency: 'EUR', anchor_date: null, horizon_date: null,
  tax_included: true, truncated: false, dates: [], total: 0,
});

/**
 * Re-groups the engine's cadence sections into one group per billing date — the
 * central rule of both tickets: the grouping is by **actual billing date**,
 * while the recurrence of each billing event remains independent.
 *
 * Independence is the engine's, not this function's: each item is its own
 * stream advancing at its own frequency, so nothing is converted to a common
 * cadence or merged into a single recurring definition. Two streams whose dates
 * happen to coincide simply land in the same group — which is exactly what
 * "Membership Fee (every 4 weeks) + Insurance Fee (monthly) on Oct 28" asks
 * for.
 *
 * Within a date the lines keep the engine's section order (one-off first, then
 * year, month, 4 weeks, …), so a one-off Registration Fee heads the first
 * group.
 */
export function groupBillingEventsByDate(
  simulation: BillingSimulationResult,
  mandatoryByCharge: Map<number, boolean>,
): { dates: BillingEventDate[]; total: number } {
  const byDate = new Map<string, BillingEventDate>();
  for (const section of simulation.sections) {
    for (const event of section.events) {
      let group = byDate.get(event.date);
      if (!group) {
        group = { date: event.date, lines: [], total: 0 };
        byDate.set(event.date, group);
      }
      for (const line of event.lines) {
        group.lines.push({
          kind: line.kind,
          label: line.label,
          gym_charge_id: line.gym_charge_id,
          mandatory: line.gym_charge_id != null && mandatoryByCharge.get(line.gym_charge_id) === true,
          quantity: line.quantity,
          unit_price: line.unit_price,
          regular_price: line.regular_price,
          actual_charge: line.actual_charge,
          prepaid_periods: line.prepaid_periods,
          benefits: line.benefits,
        });
      }
    }
  }

  const dates = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  for (const group of dates) {
    group.total = round2(group.lines.reduce((sum, line) => sum + line.actual_charge, 0));
  }
  return { dates, total: round2(dates.reduce((sum, group) => sum + group.total, 0)) };
}
