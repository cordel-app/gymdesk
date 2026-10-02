// #924 stage 4 — the Assigned Plan card's **Billing Event Forecast**: the
// database half of `domain/assignmentBillingEventSimulation.ts`.
//
// There is deliberately almost nothing here. §8 forbids a second simulation
// engine for Assigned Plans, and the reads an assignment's simulation needs
// already exist in one place — `loadSimulationAssignments()`, which the
// Member-level Billing Simulation (#629) is built from and which applies every
// snapshot rule (#635 §13–§17, §16's grant fallback, the Billing & Duration
// fallback, the Additional Periodic Services). So this module only scopes that
// loader to one assignment and hands the result to the shared projection.
//
// The two entry points below are the same pair stage 3 gave the Membership Fee
// Simulation: embedded on `GET /user-memberships/:id` with the rest of the
// card, and on its own for the refetch the card does after a configuration or
// promotion edit.

import {
  AssignmentBillingEventSimulationResult,
  computeAssignmentBillingEventSimulation,
} from '../domain/assignmentBillingEventSimulation';
import { emptyBillingEventSimulation } from '../domain/billingEventSimulation';
import { loadSimulationAssignments } from './billing-simulation';

/**
 * Why an assignment has no forecast at all. A `cancelled` or `expired` one
 * bills nothing further, so `loadSimulationAssignments()` — which reads the
 * same `SIMULATED_STATUSES` the Member-level simulation does — returns no row
 * for it, and the card says so rather than rendering an empty table.
 */
const NOT_SIMULATED_REASON =
  'This assigned plan is no longer billing, so there is nothing to forecast.';

/**
 * The Billing Event Forecast of one assignment. It always answers a projection
 * — an assignment outside this gym, or one that bills nothing further, reads as
 * `available: false`, so a caller that needs to distinguish "not found" checks
 * the row itself first (as `GET /user-memberships/:id/billing-event-simulation`
 * does).
 */
export async function assignedPlanBillingForecast(
  gymId: string, umId: number,
): Promise<AssignmentBillingEventSimulationResult> {
  const assignments = await loadSimulationAssignments(gymId, { userMembershipId: umId });
  const assignment = assignments[0];
  if (!assignment) return emptyBillingEventSimulation(NOT_SIMULATED_REASON);
  return computeAssignmentBillingEventSimulation({ assignment });
}
