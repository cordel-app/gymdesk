// #924 stage 4 — the **Billing Event Forecast** of one Assigned Plan: every
// billing event this contract will actually produce, grouped by the date it
// falls on.
//
// It is the Membership Plan card's Billing Event Simulation (#915, shared since
// #922) for a membership that really exists, and it answers a different question
// from the Membership Fee Simulation beside it (#924 stage 3): that one is one
// row per billing *period* and is about the Membership Fee alone, this one is
// one group per billing *date*, listing every line that falls on it — the fee
// plus each Sellable Item the assignment carries, each granted item of each
// standing Promotion and each Additional Periodic Service. The ticket's own
// words for the split, from the thread:
//
//   > Example timeline only displays the evolution of the membership fee while
//   > the Billing Event Simulation [...] includes all other items like
//   > registration fees, insurance fees, and other services.
//
// Neither may grow into the other, and neither is a second engine: §8 asks for
// "the billing events that will actually be created for the assigned
// membership", so this module is an **adapter**, exactly as the Plan's and the
// Promotion's are. `computeBillingSimulation()` decides every date and every
// amount from the assignment's own snapshot, `billingEventSimulation.ts` holds
// the horizon floor and the group-by-date re-grouping, and what is left here is
// only what an *existing* contract brings that a catalogue preview cannot:
//
//   1. the assignment is not hypothetical — it carries its real `starts_at`,
//      its real standing Promotions, its real Additional Periodic Services and
//      its own Personal Membership Fee Benefit, which the Plan adapter
//      deliberately leaves empty because none of them is a property of a Plan;
//   2. its billing dates reach back to a start date that may be years old, so
//      the walk is bounded from **today** (`horizonFrom`) and the groups before
//      today are dropped. What was already charged is the Billing Events ledger
//      on the same card; this section is what is still to come.
//
// Nothing is persisted and nothing is charged.

import { SimulationAssignment, computeBillingSimulation } from './billingSimulation';
import {
  BillingEventSimulationResult,
  SIMULATED_CYCLES,
  emptyBillingEventSimulation,
  groupBillingEventsByDate,
  todayUtc,
} from './billingEventSimulation';

/**
 * Why there may be nothing to forecast. Both are single, known conditions, so
 * the page says them in the viewer's own words rather than relaying these
 * (the same choice the Example Timeline and the Plan's simulation make).
 */
const NOTHING_TO_BILL_REASON =
  'This assigned plan has no price or billing frequency to project billing events from.';
const NOTHING_AHEAD_REASON = 'This assigned plan has no further billing events ahead.';

export interface AssignmentBillingEventSimulationInput {
  /**
   * The assignment as the engine prices it, built by the very loader the
   * Member's own Billing Simulation uses (`loadSimulationAssignments()`), so
   * the snapshot-first rules — the frozen cadence, the frozen Billing &
   * Duration, the frozen benefit rows, each application's own grant snapshot
   * (#635 §13–§17) — are resolved in one place rather than re-derived here.
   *
   * Its amounts are **VAT-inclusive**: §4/§8 ask this card to quote prices tax
   * included, and the whole projection is therefore denominated in gross euros
   * by the caller, exactly as the Plan's and the Promotion's are (#915's tax
   * note, #817 for why the arithmetic is the server's and never the page's).
   */
  assignment: SimulationAssignment;
  /**
   * "Today", `YYYY-MM-DD` — the date the forecast starts at and the one its
   * bounds are counted from. Defaults to the UTC date; tests pin it.
   */
  today?: string;
  /** Passed through to the engine's safety cap — tests only. */
  maxMonths?: number;
}

/**
 * The billing events this assignment will produce from `today` on, grouped by
 * date, chronological, each group totalled.
 *
 * An assignment that starts in the future is forecast from its own start date:
 * there is nothing before it, and its first group is the one carrying the
 * one-off lines (§8's Registration Fee example).
 */
export function computeAssignmentBillingEventSimulation(
  input: AssignmentBillingEventSimulationInput,
): BillingEventSimulationResult {
  const today = (input.today ?? todayUtc()).slice(0, 10);
  const { assignment } = input;
  // The forecast never begins before the contract does.
  const from = assignment.startsAt > today ? assignment.startsAt.slice(0, 10) : today;

  const simulation = computeBillingSimulation({
    assignments: [assignment],
    // §10 — two complete cycles of every recurring billing event present, so
    // the length is derived from the frequencies the assignment actually
    // carries rather than from a month count. The same floor the Plan and
    // Promotion previews use (#915 §, #922).
    minimumCycles: SIMULATED_CYCLES,
    // Counted from today rather than from a `starts_at` that may be years old.
    horizonFrom: from,
    maxMonths: input.maxMonths,
  });
  if (!simulation.available) return emptyBillingEventSimulation(NOTHING_TO_BILL_REASON);

  // `mandatory` is deliberately empty. `gym_charges.mandatory` is a property of
  // the gym's *current* catalogue (#832/#893), and this card reports what this
  // member was agreed: a line is on it because the assignment's snapshot
  // carries it, not because the item is mandatory today. The Assigned Plan's
  // own Benefit sections make the same choice.
  const grouped = groupBillingEventsByDate(simulation, new Map(), from);
  if (grouped.dates.length === 0) return emptyBillingEventSimulation(NOTHING_AHEAD_REASON);

  return {
    available: true,
    reason: null,
    currency: 'EUR',
    // The date the forecast is counted from, which for an existing contract is
    // today rather than an enrollment the card would be inventing.
    anchor_date: from,
    horizon_date: simulation.horizon_date,
    tax_included: true,
    truncated: simulation.truncated,
    ...grouped,
  };
}
