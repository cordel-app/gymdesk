// #924 stage 4 — the **Billing Event Forecast** of one Assigned Plan: every
// billing event this contract still has ahead of it, grouped by the date it
// falls on.
//
// §8–§10 of the ticket ask the Assigned Plan card for the Membership Plan
// card's Billing Event Simulation (#915), for a contract that really exists,
// and name the one rule that matters:
//
//   > The simulation must use the same billing and pricing logic as the actual
//   > system. Do not implement a separate simulation engine for Assigned Plans.
//
// So this is the **third adapter** over `domain/billingEventSimulation.ts`,
// beside `planBillingEventSimulation.ts` and `promotionBillingEventSimulation.ts`
// (#922's rule: each entity owns only the adapter that expresses itself as the
// engine's input). The difference is what the other two cannot have: this one
// does not *invent* an assignment, it is handed the real one — the very
// `SimulationAssignment` the member-level Billing Simulation (#629) and the
// nightly run's own inputs are built from, frozen snapshot and all — so there
// is nothing here to disagree with billing about.
//
// What it does of its own is exactly two things, both about *where the
// projection runs*, never about what anything costs:
//
//   1. It anchors the horizon on today (`horizonFrom`), because the engine's
//      streams start at the contract's real `starts_at`: without it, a member
//      who enrolled three years ago would have both the two-cycle floor and the
//      engine's 36-month safety cap measured from 2023 and the forecast would
//      be empty.
//   2. It drops the groups before today, which are the dates this assignment
//      has already been charged on — the Billing Events section of the same
//      card is the ledger of those, and this section answers "what is next".
//      The engine still walks from `starts_at`, because that is what decides
//      which period a future date falls in and therefore what it costs.
//
// Everything else is the engine's: which streams exist, the Promotions applied
// to this assignment inside their own agreed windows, its Additional Periodic
// Services, its frozen Plan Benefit rows and their `(action, value)` pairs, its
// Billing & Duration, its Personal Membership Fee Benefit, and every amount.
//
// **Tax.** Unlike the two hypothetical adapters, which gross a catalogue price
// up before handing it over, this projection is denominated in the amounts the
// assignment is actually billed: the frozen Membership Fee that
// `priceMembershipFeeOn()` prices each cycle from, and each benefit line's
// frozen `unit_price`. That is the same figure the Membership Fee Simulation
// above it quotes (stage 3) and the same one the nightly run charges, which is
// what keeps the two tables on one card from naming two prices for one date;
// no tax arithmetic happens here or in the page (#817).
//
// Nothing is persisted and nothing is charged.

import { SimulationAssignment, computeBillingSimulation } from './billingSimulation';
import {
  periodContaining,
  timelineCycleFor,
  timelineCycleHorizon,
} from './exampleTimeline';
import { planDurationCycleIteration } from './planDuration';
import {
  BillingEventSimulationResult,
  SIMULATED_CYCLES,
  emptyBillingEventSimulation,
  groupBillingEventsByDate,
  todayUtc,
} from './billingEventSimulation';

export type AssignmentBillingEventSimulationResult = BillingEventSimulationResult;

export interface AssignmentBillingEventSimulationInput {
  /**
   * The assignment as the engine prices it — built by the Billing Simulation's
   * own loader, so the snapshot rules (#635 §13–§17) are already applied and
   * this module has no reads and no fallbacks of its own.
   */
  assignment: SimulationAssignment;
  /**
   * "Today", `YYYY-MM-DD`: where the forecast starts and what the horizon is
   * measured from. Defaults to the UTC date — tests pin it.
   */
  from?: string;
  /** Passed through to the engine's safety cap — tests only. */
  maxMonths?: number;
}

const NOTHING_TO_BILL_REASON =
  'This assigned plan has nothing further to bill, so there is nothing to forecast.';

/**
 * The billing events still ahead of this assignment, grouped by date.
 *
 * An assignment whose configuration bills nothing at all (no fee, no cadence,
 * no benefits), and one whose every remaining date falls before `from` — an
 * `ends_at` already passed, a one-off-only configuration already charged —
 * both report `available: false`, so the card says so in the viewer's language
 * rather than rendering an empty table.
 */
export function computeAssignmentBillingEventSimulation(
  input: AssignmentBillingEventSimulationInput,
): AssignmentBillingEventSimulationResult {
  const from = (input.from ?? todayUtc()).slice(0, 10);

  // #1130 stage 3 — the cycle this contract's own frozen `auto_renew` describes,
  // from the same helper the Membership Fee Simulation above this section asks.
  // A repeating one is also the horizon, counted from the **same** period that
  // table starts at (the one containing today), so the two cover the same dates
  // and the card cannot group a third iteration of cards the rows never list.
  const duration = input.assignment.planDuration;
  const startsAt = input.assignment.startsAt.slice(0, 10);
  const cycle = timelineCycleFor(duration);
  const { startOn } = periodContaining(startsAt, from, duration.cadence);
  const simulation = computeBillingSimulation({
    assignments: [input.assignment],
    minimumCycles: SIMULATED_CYCLES,
    horizonFrom: from,
    horizonUntil: timelineCycleHorizon(startOn, duration.cadence, cycle) ?? undefined,
    maxMonths: input.maxMonths,
  });
  if (!simulation.available) return emptyBillingEventSimulation(NOTHING_TO_BILL_REASON);

  // Mandatory is a Membership *Plan*'s question (#832/#893): it says a catalogue
  // item must be part of every Plan benefit section, and it is read when a Plan's
  // sections are composed. An assignment bills what it was agreed with, frozen,
  // so flagging one of its lines from today's catalogue would claim something
  // about this contract that the contract never captured.
  const grouped = groupBillingEventsByDate(simulation, new Map(), {
    from,
    // The real iteration, counted from the contract's own `starts_at`: a member
    // on their third cycle reads `3` and `4` rather than being relabelled `1`
    // and `2`, exactly as the rows above do.
    iterationOf: (date) => planDurationCycleIteration(duration, startsAt, date),
  });
  if (grouped.dates.length === 0) return emptyBillingEventSimulation(NOTHING_TO_BILL_REASON);

  return {
    available: true,
    reason: null,
    currency: 'EUR',
    // The date the forecast runs from, not a hypothetical enrollment date: the
    // contract's own anchor is its `starts_at` and the amounts already count
    // from it.
    anchor_date: from,
    horizon_date: simulation.horizon_date,
    tax_included: true,
    truncated: simulation.truncated,
    cycle,
    ...grouped,
  };
}
