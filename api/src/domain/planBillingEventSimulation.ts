// #915 — a Membership Plan's **Billing Event Simulation**: the billing events a
// member enrolling on this Plan today would actually be charged, grouped by the
// date each one falls on.
//
// It is the third of the Plan card's read-only projections and it deliberately
// answers a different question from the other two:
//
//  * **Example Timeline** (#818) — one row per *billing period* of the Plan's
//    own cadence, saying what that period's Membership Fee status is. It knows
//    nothing about Sellable Items.
//  * **Billing Event Simulation** (this module) — one group per *billing date*,
//    listing every line that falls on it: the Membership Fee and each of the
//    Plan's One-off / Session / Period Benefits, mandatory items included, each
//    at the price the Plan's own `(action, value)` treatment gives it.
//
// The ticket's load-bearing requirement is that this must not become a second
// billing engine ("a read-only projection of the same billing-event logic used
// by the actual membership/billing system"), so it is a thin adapter over
// `domain/billingSimulation.ts`: the Plan is expressed as the hypothetical
// assignment a member enrolling today would hold, `computeBillingSimulation()`
// decides every date and every amount, and this module only
//
//   1. supplies the `minimumCycles` floor the ticket's horizon rule needs, and
//   2. re-groups the engine's cadence sections by date.
//
// Nothing here decides which period is Free / Pre-paid / Pay / Bonus (that is
// `classifyPlanDurationPeriod()`, reached through the engine), what a benefit
// pair does to a line (`applyLineBenefit()`), or when the next charge falls
// (`advanceBillingDate()`). Nothing is persisted and nothing is charged.
//
// **Tax.** The whole projection runs in VAT-inclusive euros: the caller converts
// the Plan's price and each item's price to its gross amount first, so every
// number the engine returns is already the amount the ticket wants displayed
// ("€70.00 (tax included)") and no tax arithmetic happens here or in the
// frontend (#817). That conversion is exact rather than an approximation because
// a Membership Plan may only configure `no_benefit`, `waive` and
// `percentage_discount` on a Sellable Item (#896 §16) — a percentage of the
// gross is the gross of the percentage — and its Billing & Duration only ever
// waives outright. An item with no tax rate configured contributes its stored
// amount, exactly as `formatPlanCurrentPrice()` falls back for the Plan's own
// price.

import {
  BillingSimulationResult,
  SimulationAssignment,
  SimulationBenefit,
  SellableItemFrequency,
  computeBillingSimulation,
} from './billingSimulation';
import { PlanDuration, withDurationCadence } from './planDuration';
import { PlanTimelineCadence } from './planExampleTimeline';
import { NO_PERSONAL_FEE_BENEFIT } from './personalFeeBenefit';
import { SellableItemBenefit } from './sellableItemBenefitActions';
import { SellableItemBenefitCategory } from './sellableItemClassification';

/**
 * How many complete cycles of every recurring billing frequency the simulation
 * spans. Two, per the ticket: "the simulation must be long enough to show two
 * complete cycles of the yearly event", so a Plan carrying a yearly item runs
 * two years and drags the 4-weekly ones along with it, and the length is
 * derived from the frequencies present rather than being a fixed number of
 * months.
 *
 * Because an event lands on the horizon itself, the fastest stream shows three
 * charges — the Sep 30 / Oct 28 / Nov 25 shape the ticket's own example has for
 * a lone 4-weekly Membership Fee.
 */
export const SIMULATED_CYCLES = 2;

/**
 * One Sellable Item the Plan carries, as this projection needs it: the item's
 * catalogue identity, the quantity and pricing treatment the Plan's benefit row
 * configures, and its **gross** unit price.
 */
export interface PlanSimulationItem {
  gymChargeId: number;
  name: string;
  category: SellableItemBenefitCategory;
  billingFrequency: SellableItemFrequency | null;
  /** The item's unit price including VAT (see the tax note in the header). */
  unitPriceInclTax: number;
  quantity: number;
  /** The Plan benefit row's own `(action, value)` pair (#896). */
  benefit: SellableItemBenefit;
  /** `gym_charges.mandatory` — the ticket labels such a line "(Mandatory)". */
  mandatory: boolean;
}

export interface PlanBillingEventSimulationInput {
  planName: string | null;
  /**
   * The Plan's Billing & Duration, already normalized by `toPlanDuration()`.
   * Re-bound to `cadence` below for #892's reason, so the periods the durations
   * are counted in and the periods the fee is billed in cannot disagree.
   */
  duration: PlanDuration;
  /** The Plan's `billing_policies` pair, or `null` when it has none. */
  cadence: PlanTimelineCadence | null;
  /** The Plan's current price including VAT, or `null` when it has no price. */
  membershipFeeInclTax: number | null;
  /** The Plan's three Benefit sections, mandatory items merged in already. */
  items: PlanSimulationItem[];
  /** Hypothetical enrollment date, `YYYY-MM-DD`. Defaults to today (UTC). */
  anchorDate?: string;
  /** Passed through to the engine's safety cap — tests only. */
  maxMonths?: number;
}

/** One line of one billing event. The money fields are the engine's, verbatim. */
export interface PlanSimulationLine {
  kind: 'membership_fee' | 'sellable_item';
  label: string;
  gym_charge_id: number | null;
  /** True when this line exists because the Sellable Item is Mandatory (#832). */
  mandatory: boolean;
  quantity: number;
  unit_price: number;
  /** Before the Plan's own treatment — what the ticket calls "Regular price". */
  regular_price: number;
  /** After it. `0` for a waived line, which is still shown (the ticket's §Waive). */
  actual_charge: number;
  /** Why `actual_charge` differs from `regular_price`; empty at the regular price. */
  benefits: SimulationBenefit[];
}

/** Every line that falls on one billing date, and what that date costs. */
export interface PlanSimulationDate {
  date: string;
  lines: PlanSimulationLine[];
  total: number;
}

export interface PlanBillingEventSimulationResult {
  available: boolean;
  /** Why there is nothing to simulate, for the caller to render in its own words. */
  reason: string | null;
  currency: 'EUR';
  /** The hypothetical enrollment date the dates were counted from. */
  anchor_date: string | null;
  /** The last date the projection runs to. */
  horizon_date: string | null;
  /** The amounts are gross (see the tax note in the header). */
  tax_included: boolean;
  /** True when the engine's safety cap was reached before the horizon rule was met. */
  truncated: boolean;
  dates: PlanSimulationDate[];
  total: number;
}

const NO_CADENCE_REASON = 'Configure a billing frequency to preview the billing events.';
const NOTHING_TO_BILL_REASON = 'Configure a plan price or a benefit to preview the billing events.';

const round2 = (n: number): number => Math.round(n * 100) / 100;

const empty = (reason: string | null): PlanBillingEventSimulationResult => ({
  available: false, reason, currency: 'EUR', anchor_date: null, horizon_date: null,
  tax_included: true, truncated: false, dates: [], total: 0,
});

/**
 * Projects the Plan as the assignment a member enrolling on `anchorDate` would
 * hold, and returns the resulting billing events grouped by date.
 *
 * The hypothetical assignment carries **no** Promotions, no Additional Periodic
 * Services and no Personal Membership Fee Benefit: none of those is a property
 * of the Plan, and inventing one would show a price no member is promised. It
 * is open-ended (`endsAt: null`) because a Plan's Paid Duration says how long
 * the contract runs, not when billing stops — after it the Plan keeps charging
 * the regular price, which is what `classifyPlanDurationPeriod()` already says
 * and what the Example Timeline's trailing regular rows already show.
 */
export function computePlanBillingEventSimulation(
  input: PlanBillingEventSimulationInput,
): PlanBillingEventSimulationResult {
  const { cadence } = input;
  if (!cadence || !Number.isInteger(Number(cadence.interval)) || Number(cadence.interval) < 1) {
    return empty(NO_CADENCE_REASON);
  }

  const anchor = (input.anchorDate ?? new Date().toISOString().slice(0, 10)).slice(0, 10);
  const assignment: SimulationAssignment = {
    // The Plan is not assigned to anybody; the id only keys the engine's lines.
    userMembershipId: 0,
    planName: input.planName,
    startsAt: anchor,
    endsAt: null,
    membershipFeePrice: input.membershipFeeInclTax,
    recurringInterval: Number(cadence.interval),
    recurringUnit: cadence.unit,
    promotions: [],
    services: [],
    planBenefits: input.items.map((item) => ({
      gymChargeId: item.gymChargeId,
      name: item.name,
      category: item.category,
      billingFrequency: item.billingFrequency,
      unitPrice: item.unitPriceInclTax,
      quantity: item.quantity,
      benefit: item.benefit,
    })),
    // #892 — the durations count periods of the very cadence the fee is billed at.
    planDuration: withDurationCadence(input.duration, cadence),
    personalFeeBenefit: NO_PERSONAL_FEE_BENEFIT,
  };

  const simulation = computeBillingSimulation({
    assignments: [assignment],
    minimumCycles: SIMULATED_CYCLES,
    maxMonths: input.maxMonths,
  });
  if (!simulation.available) return empty(NOTHING_TO_BILL_REASON);

  const mandatoryByCharge = new Map<number, boolean>();
  for (const item of input.items) {
    if (item.mandatory) mandatoryByCharge.set(item.gymChargeId, true);
  }

  return {
    available: true,
    reason: null,
    currency: 'EUR',
    anchor_date: anchor,
    horizon_date: simulation.horizon_date,
    tax_included: true,
    truncated: simulation.truncated,
    ...groupByDate(simulation, mandatoryByCharge),
  };
}

/**
 * Re-groups the engine's cadence sections into one group per billing date — the
 * ticket's central rule: "the grouping is by **actual billing date**, while the
 * recurrence of each billing event remains independent".
 *
 * Independence is the engine's, not this function's: each item is its own stream
 * advancing at its own frequency, so nothing is converted to a common cadence or
 * merged into a single recurring definition. Two streams whose dates happen to
 * coincide simply land in the same group — which is exactly what the ticket's
 * "Membership Fee (every 4 weeks) + Insurance Fee (monthly) on Jan 20" example
 * asks for.
 *
 * Within a date the lines keep the engine's section order (one-off first, then
 * year, month, 4 weeks, …), so a one-off Registration Fee heads the first group.
 */
function groupByDate(
  simulation: BillingSimulationResult,
  mandatoryByCharge: Map<number, boolean>,
): { dates: PlanSimulationDate[]; total: number } {
  const byDate = new Map<string, PlanSimulationDate>();
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
