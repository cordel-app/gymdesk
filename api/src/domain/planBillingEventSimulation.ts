// #915 — a Membership Plan's **Billing Event Simulation**: the billing events a
// member enrolling on this Plan today would actually be charged, grouped by the
// date each one falls on.
//
// It is the third of the Plan card's read-only projections and it deliberately
// answers a different question from the other two:
//
//  * **Example Timeline** (#818) — one row per *billing period* of the Plan's
//    own cadence, saying what that period's Membership Fee status is. It knows
//    nothing about Products.
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
// Since #922 both of those belong to `domain/billingEventSimulation.ts`, which
// the Promotion card's own simulation adapts the same engine through: what is
// left here is only the Plan's **context** — how a Membership Plan becomes that
// hypothetical assignment.
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
// `percentage_discount` on a Product (#896 §16) — a percentage of the
// gross is the gross of the percentage — and its Billing & Duration only ever
// waives outright. An item with no tax rate configured contributes its stored
// amount, exactly as `formatPlanCurrentPrice()` falls back for the Plan's own
// price.

import {
  SimulationAssignment,
  ProductFrequency,
  computeBillingSimulation,
} from './billingSimulation';
import {
  BillingEventDate,
  BillingEventLine,
  BillingEventSimulationResult,
  SIMULATED_CYCLES,
  emptyBillingEventSimulation,
  groupBillingEventsByDate,
  todayUtc,
} from './billingEventSimulation';
import { PlanDuration, withDurationCadence } from './planDuration';
import { PlanTimelineCadence } from './planExampleTimeline';
import { NO_PERSONAL_FEE_BENEFIT } from './personalFeeBenefit';
import { ProductBenefit } from './productBenefitActions';
import { SessionBenefitFrequency } from './sessionBenefitFrequency';
import { ProductBenefitCategory } from './productClassification';

// The horizon floor and the result shape are the shared projection's (#922);
// re-exported so #915's own importers and tests keep reading them from here.
export { SIMULATED_CYCLES };
export type PlanSimulationLine = BillingEventLine;
export type PlanSimulationDate = BillingEventDate;
export type PlanBillingEventSimulationResult = BillingEventSimulationResult;

/**
 * One Product the Plan carries, as this projection needs it: the item's
 * catalogue identity, the quantity and pricing treatment the Plan's benefit row
 * configures, and its **gross** unit price.
 */
export interface PlanSimulationItem {
  gymChargeId: number;
  name: string;
  category: ProductBenefitCategory;
  billingFrequency: ProductFrequency | null;
  /** The item's unit price including VAT (see the tax note in the header). */
  unitPriceInclTax: number;
  quantity: number;
  /**
   * #918 — a Session Benefit's own renewal Frequency ("2 sessions per week"),
   * `null` for every other section and for a session row configured with none.
   * The engine is what turns it into one summarised line per billing date.
   */
  sessionFrequency: SessionBenefitFrequency | null;
  /** The Plan benefit row's own `(action, value)` pair (#896). */
  benefit: ProductBenefit;
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

const NO_CADENCE_REASON = 'Configure a billing frequency to preview the billing events.';
const NOTHING_TO_BILL_REASON = 'Configure a plan price or a benefit to preview the billing events.';

const empty = emptyBillingEventSimulation;

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

  const anchor = (input.anchorDate ?? todayUtc()).slice(0, 10);
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
      sessionFrequency: item.sessionFrequency,
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
    ...groupBillingEventsByDate(simulation, mandatoryByCharge),
  };
}
