// #2624 stage 3 (§2) — the database half of `domain/assignedLineEnginePrices.ts`.
//
// The Assigned Plan card's three benefit sections report a Final Price per line.
// For a line a Promotion covers, that price is the billing engine's: this module
// runs the engine over the assignment exactly as the Billing Event Forecast does
// (`loadSimulationAssignments()` scoped to one assignment, the one loader the
// Member-level Billing Simulation and the forecast read), and overlays the figure
// on the snapshot rows. Nothing is priced here and nothing is persisted.
//
// Its own module because `billing-simulation.ts` reads `assigned-plan-snapshot.ts`
// (the benefit loader), so the snapshot module cannot import the engine loader
// back.

import {
  currentProductCharges,
  finalPriceWithPromotion,
  EngineLineCharge,
} from '../domain/assignedLineEnginePrices';
import { computeBillingSimulation } from '../domain/billingSimulation';
import { SIMULATED_CYCLES, todayUtc } from '../domain/billingEventSimulation';
import {
  AssignedPlanBenefitRow,
  AssignedPlanSnapshot,
  loadAssignedPlanBenefitSection,
  loadAssignedPlanSnapshot,
} from './assigned-plan-snapshot';
import { loadSimulationAssignments } from './billing-simulation';
import type { ProductBenefitCategory } from '../domain/productClassification';

/** The engine's charge per Product for the assignment's current cycle; empty when it bills nothing. */
async function engineChargesFor(gymId: string, umId: number): Promise<Map<number, EngineLineCharge>> {
  const [assignment] = await loadSimulationAssignments(gymId, { userMembershipId: umId });
  if (!assignment) return new Map();
  const today = todayUtc();
  const simulation = computeBillingSimulation({
    assignments: [assignment],
    minimumCycles: SIMULATED_CYCLES,
    horizonFrom: today,
  });
  return currentProductCharges(simulation, today);
}

function overlay(rows: AssignedPlanBenefitRow[], charges: Map<number, EngineLineCharge>): AssignedPlanBenefitRow[] {
  if (charges.size === 0) return rows;
  return rows.map((row) => ({ ...row, ...finalPriceWithPromotion(row, charges.get(Number(row.product_id))) }));
}

/** `loadAssignedPlanSnapshot()` with each line's Final Price including its Promotion Benefit. */
export async function loadPricedAssignedPlanSnapshot(gymId: string, umId: number): Promise<AssignedPlanSnapshot> {
  const [snapshot, charges] = await Promise.all([
    loadAssignedPlanSnapshot(gymId, umId),
    engineChargesFor(gymId, umId),
  ]);
  return {
    ...snapshot,
    session_benefits: overlay(snapshot.session_benefits, charges),
    oneoff_benefits: overlay(snapshot.oneoff_benefits, charges),
    periodical_benefits: overlay(snapshot.periodical_benefits, charges),
  };
}

/** `loadAssignedPlanBenefitSection()` with the same overlay. */
export async function loadPricedAssignedPlanBenefitSection(
  gymId: string, umId: number, category: ProductBenefitCategory,
): Promise<AssignedPlanBenefitRow[]> {
  const [rows, charges] = await Promise.all([
    loadAssignedPlanBenefitSection(gymId, umId, category),
    engineChargesFor(gymId, umId),
  ]);
  return overlay(rows, charges);
}
