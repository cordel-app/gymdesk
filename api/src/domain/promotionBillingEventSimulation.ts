// #922 — a Promotion's **Billing Event Simulation**: the billing events a
// Promotion affects, grouped by the date each one falls on, with what each line
// would otherwise have cost beside what it costs with the Promotion applied.
//
// It is the Promotion card's counterpart to the Membership Plan card's
// simulation (#915) and it is deliberately the *same* projection: the ticket's
// load-bearing clause is
//
//   > The simulation must use the same pricing and promotion calculation as the
//   > actual billing system. Do not create a second pricing engine specifically
//   > for the simulation. [...] The only difference should be the input/context.
//
// so everything but the context lives in `domain/billingEventSimulation.ts` and
// everything about *billing* lives in `domain/billingSimulation.ts`. This module
// does exactly what the Plan's adapter does, one entity over:
//
//   1. expresses the Promotion as the hypothetical assignment of a member who
//      is given it today, and
//   2. hands that to `computeBillingSimulation()` with the shared horizon floor.
//
// Nothing here decides a date, an amount or which units a grant covers — that is
// `buildItemStream()` / `buildItemSingleCharge()` over `applyLineBenefit()`, the
// very code the nightly run prices an applied Promotion with. Nothing is
// persisted and nothing is charged.
//
// **What is in it, and what is deliberately not.** A Promotion's own property is
// the Products it grants, so those are the lines: each at its catalogue
// price, treated by the grant's own `(action, value)` pair (#896) for the units
// or periods the grant covers, and at the regular price after that — which is
// the ticket's own "No applicable promotion → Final Price = Regular Price" case.
//
// There is **no Membership Fee line**. A Promotion carries no fee of its own:
// the fee belongs to whichever Membership Plan the Promotion is later applied
// alongside, and its amount, its billing frequency and its Billing & Duration
// are that Plan's. Inventing one here would advertise a price no member is
// promised — the same reason #915's hypothetical assignment carries no
// Promotions, no Additional Periodic Services and no Personal Membership Fee
// Benefit. What the Promotion does to a fee is already the Promotion card's
// **Example Timeline**, which is one row per period of the Promotion's own
// Free / Paid / Bonus timeline and is where its Membership Fee Promotion is
// shown; this section is one group per billing *date* over its Products.
// The two answer different questions and neither may grow into the other.
//
// **Tax.** As on the Plan side the whole projection runs in VAT-inclusive euros:
// the caller grosses each item's unit price up once (`grossBenefitUnitPrice()`,
// shared with the Benefit sections' own Regular/Final Price pair), so the
// engine's numbers are already the amounts the ticket wants displayed and no tax
// arithmetic happens here or in the page (#817).

import {
  ProductFrequency,
  SimulationAssignment,
  SimulationGrant,
  computeBillingSimulation,
} from './billingSimulation';
import {
  BillingEventSimulationResult,
  SIMULATED_CYCLES,
  emptyBillingEventSimulation,
  groupBillingEventsByDate,
  todayUtc,
} from './billingEventSimulation';
import { NO_PLAN_DURATION } from './planDuration';
import { NO_PERSONAL_FEE_BENEFIT } from './personalFeeBenefit';
import { ProductBenefit } from './productBenefitActions';
import { ProductBenefitCategory } from './productClassification';

/**
 * One Product the Promotion grants, as this projection needs it: the
 * item's catalogue identity, what the grant covers and how it prices it, and
 * the item's **gross** unit price.
 */
export interface PromotionSimulationGrant {
  productId: number;
  name: string;
  category: ProductBenefitCategory;
  billingFrequency: ProductFrequency | null;
  /** The item's unit price including VAT (see the tax note in the header). */
  unitPriceInclTax: number;
  /** Units covered for a Session / One-off item, periods for a Periodical one. */
  quantity: number;
  /** The grant row's own `(action, value)` pair (#896) — what it does to those units. */
  benefit: ProductBenefit;
}

export interface PromotionBillingEventSimulationInput {
  promotionName: string | null;
  /**
   * The Promotion's `starts_at`, `YYYY-MM-DD`. A Promotion that has not begun
   * yet is simulated from its own start date rather than from today, since that
   * is the first day it could be given to anybody.
   */
  startsAt?: string | null;
  /**
   * The Promotion's Free / Paid / Bonus / Pay Beforehand months. Carried
   * through as the application's own timeline so this hypothetical reads
   * exactly like a real one; the grants' coverage is bounded by their own
   * quantities rather than by these months, which is the engine's rule and not
   * this module's to restate.
   */
  freeMonths?: number | null;
  paidMonths?: number | null;
  payBeforehandMonths?: number | null;
  bonusMonths?: number | null;
  grants: PromotionSimulationGrant[];
  /** Hypothetical enrollment date, `YYYY-MM-DD`. Defaults to today (UTC). */
  anchorDate?: string;
  /** Passed through to the engine's safety cap — tests only. */
  maxMonths?: number;
}

export type PromotionBillingEventSimulationResult = BillingEventSimulationResult;

const NOTHING_GRANTED_REASON =
  'Add a promoted Product to preview the billing events this Promotion affects.';

/**
 * Projects the Promotion as applied, on `anchorDate`, to a member who starts
 * then, and returns the resulting billing events grouped by date.
 *
 * The hypothetical assignment has no Membership Plan behind it — no fee, no
 * cadence of its own and no Plan Benefit rows (see the header) — so every line
 * it produces is one of the Promotion's own grants. The application is
 * open-ended (`revokedAt: null`), because a Promotion reaching its End Date
 * never revokes an application that is already standing (#900): what ends a
 * grant is its own quantity of covered units or periods.
 */
export function computePromotionBillingEventSimulation(
  input: PromotionBillingEventSimulationInput,
): PromotionBillingEventSimulationResult {
  const grants: SimulationGrant[] = input.grants.map((grant) => ({
    productId: grant.productId,
    name: grant.name,
    category: grant.category,
    billingFrequency: grant.billingFrequency,
    unitPrice: grant.unitPriceInclTax,
    quantity: grant.quantity,
    benefit: grant.benefit,
  }));
  if (grants.length === 0) return emptyBillingEventSimulation(NOTHING_GRANTED_REASON);

  // A Promotion that starts in the future is simulated from its start date: an
  // application dated before `starts_at` is one no apply path would ever write.
  const today = todayUtc();
  const start = input.startsAt ? input.startsAt.slice(0, 10) : null;
  const anchor = (input.anchorDate ?? (start && start > today ? start : today)).slice(0, 10);

  const assignment: SimulationAssignment = {
    // The Promotion is not applied to anybody; the id only keys the engine's lines.
    userMembershipId: 0,
    planName: null,
    startsAt: anchor,
    endsAt: null,
    // No Plan behind the hypothetical, so no Membership Fee stream (see header).
    membershipFeePrice: null,
    recurringInterval: null,
    recurringUnit: null,
    promotions: [{
      name: input.promotionName,
      appliedAt: anchor,
      revokedAt: null,
      freeMonths: Math.max(0, Math.trunc(Number(input.freeMonths ?? 0)) || 0),
      paidMonths: Math.max(0, Math.trunc(Number(input.paidMonths ?? 0)) || 0),
      payBeforehandMonths: Math.max(0, Math.trunc(Number(input.payBeforehandMonths ?? 0)) || 0),
      bonusMonths: Math.max(0, Math.trunc(Number(input.bonusMonths ?? 0)) || 0),
      // The Membership Fee Benefit is not read here: with no fee to price there
      // is nothing for it to discount, and passing it would imply otherwise.
      membershipFeeBenefits: [],
      grants,
    }],
    services: [],
    planBenefits: [],
    // No Plan, so no Billing & Duration: nothing to classify as Free / Pre-paid
    // / Bonus, which only ever waives a Membership Fee anyway.
    planDuration: NO_PLAN_DURATION,
    personalFeeBenefit: NO_PERSONAL_FEE_BENEFIT,
  };

  const simulation = computeBillingSimulation({
    assignments: [assignment],
    minimumCycles: SIMULATED_CYCLES,
    maxMonths: input.maxMonths,
  });
  if (!simulation.available) return emptyBillingEventSimulation(NOTHING_GRANTED_REASON);

  return {
    available: true,
    reason: null,
    currency: 'EUR',
    anchor_date: anchor,
    horizon_date: simulation.horizon_date,
    tax_included: true,
    truncated: simulation.truncated,
    // #1130 stage 3 — a Promotion has no Billing & Duration of its own
    // (`NO_PLAN_DURATION` above), so there is no cycle to group its cards by and
    // no `↻ Repeats indefinitely` to claim. The section renders exactly as it
    // did before that ticket, which is why no `iterationOf` is passed either.
    cycle: null,
    // Mandatory is a Membership Plan's question (#893): a Promotion grants what
    // it grants, so no line here is flagged.
    ...groupBillingEventsByDate(simulation, new Map()),
  };
}
