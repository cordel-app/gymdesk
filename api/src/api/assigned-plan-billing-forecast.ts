// #924 stage 4 — the Assigned Plan card's **Billing Event Forecast**: the
// database half of `domain/assignmentBillingEventSimulation.ts`.
//
// It does exactly two things of its own, and neither of them is a billing rule:
//
//   1. it reads the assignment through `loadSimulationAssignments()` — the very
//      loader the Member's consolidated Billing Simulation uses, so the
//      snapshot-first rules of #635 §13–§17 are resolved in one place; and
//   2. it re-denominates that assignment in **VAT-inclusive euros**, because
//      §4/§8 ask this card to quote prices tax included.
//
// **Why the tax rate is read live.** A snapshot freezes what was *agreed* — the
// price, the quantity, the `(action, value)` pair, the cadence, the durations —
// and a statutory VAT rate is none of those: it is not a term of the contract
// and the snapshot never captured one. So the gross-up reads each item's
// current `tax_behavior` + rate, exactly as the card's own Benefit sections do
// (#924 stage 1), and the *amount* it grosses up is still the frozen one — a
// Sellable Item repriced since moves nothing (§17). The one gross-up is
// `grossBenefitUnitPrice()` (`sellable-item-benefit-pricing.ts`), so the three
// Benefit sections, the Promotion grant sections and this forecast cannot quote
// one line two different ways (#817: the arithmetic is the server's, never the
// page's).
//
// The conversion is exact for every proportional treatment (`waive`,
// `percentage_discount`), and an amount-taking one (`fixed_discount`,
// `fixed_price`, which a Promotion may configure) is taken at face value as the
// VAT-inclusive figure the gym typed — the same reading #919/#920 already give
// those two actions on this very card, so the sections and the forecast agree.

import { db } from '../infra/db';
import { AssignmentRow, loadSimulationAssignments } from './billing-simulation';
import { grossBenefitUnitPrice } from './sellable-item-benefit-pricing';
import { selectPlanTaxRates } from '../domain/planTaxRate';
import type { SimulationAssignment } from '../domain/billingSimulation';
import {
  computeAssignmentBillingEventSimulation,
} from '../domain/assignmentBillingEventSimulation';
import {
  BillingEventSimulationResult,
  emptyBillingEventSimulation,
} from '../domain/billingEventSimulation';

/** An item's tax treatment, as the gross-up needs it. */
export interface TaxTreatment {
  tax_behavior: string | null;
  tax_rate_percent: string | number | null;
}

/** What this assignment's amounts are grossed up with. */
export interface AssignmentTaxTreatments {
  /** The Membership Fee's — the Plan's own `tax_behavior` and effective rate (#817). */
  fee: TaxTreatment | null;
  /** Each Sellable Item's, by `gym_charges.id`. */
  byCharge: Map<number, TaxTreatment>;
}

/**
 * One amount, VAT included. An item with no rate configured contributes its
 * stored amount — the only honest answer when there is no tax to include, and
 * the same fallback `grossBenefitUnitPrice()` and `formatPlanCurrentPrice()`
 * already make.
 */
function gross(amount: number, tax: TaxTreatment | null | undefined): number {
  return grossBenefitUnitPrice({
    gym_charge_id: 0,
    quantity: 1,
    gym_charge_amount: amount,
    gym_charge_tax_behavior: tax?.tax_behavior ?? 'inclusive',
    gym_charge_tax_rate_percent: tax?.tax_rate_percent ?? null,
  }) ?? amount;
}

/**
 * The same assignment, with every amount the engine prices re-denominated in
 * VAT-inclusive euros: the Membership Fee, each frozen Plan benefit line, each
 * granted line of each standing Promotion and each Additional Periodic Service.
 *
 * Pure — the treatments are looked up by the caller, so this is the whole of
 * what "tax included" means for the forecast and is testable without a database.
 */
export function grossSimulationAssignment(
  assignment: SimulationAssignment, taxes: AssignmentTaxTreatments,
): SimulationAssignment {
  const forCharge = (id: number) => taxes.byCharge.get(Number(id)) ?? null;
  return {
    ...assignment,
    membershipFeePrice: assignment.membershipFeePrice != null
      ? gross(assignment.membershipFeePrice, taxes.fee) : assignment.membershipFeePrice,
    planBenefits: assignment.planBenefits.map((b) => ({
      ...b, unitPrice: gross(b.unitPrice, forCharge(b.gymChargeId)),
    })),
    services: assignment.services.map((s) => ({
      ...s, unitPrice: gross(s.unitPrice, forCharge(s.gymChargeId)),
    })),
    promotions: assignment.promotions.map((p) => ({
      ...p,
      grants: p.grants.map((g) => ({
        ...g, unitPrice: gross(g.unitPrice, forCharge(g.gymChargeId)),
      })),
    })),
  };
}

/**
 * The tax treatment of everything this assignment bills: each Sellable Item's
 * own (live, by id) and the Membership Fee's, which is the Plan's
 * `tax_behavior` at the rate `selectPlanTaxRates()` resolves — the Plan's own,
 * else the gym's system rate, which is what "Default" means (#817). An
 * assignment whose Plan is gone has no fee rate and its fee is its stored
 * amount.
 */
async function loadTaxTreatments(
  gymId: string, row: AssignmentRow, chargeIds: number[],
): Promise<AssignmentTaxTreatments> {
  const ids = [...new Set(chargeIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  const [charges, plan] = await Promise.all([
    ids.length === 0 ? Promise.resolve([]) : db.query<{
      id: number; tax_behavior: string | null; tax_rate_percent: string | null;
    }>(
      `SELECT gc.id, gc.tax_behavior, tr.rate_percent AS tax_rate_percent
         FROM gym_charges gc
         LEFT JOIN tax_rates tr ON tr.id = gc.tax_rate_id
        WHERE gc.gym_id = ? AND gc.id IN (${ids.map(() => '?').join(',')})`,
      [gymId, ...ids],
    ).then((r) => r.rows),
    row.membership_plan_id == null ? Promise.resolve(null) : loadPlanTaxTreatment(gymId, row.membership_plan_id),
  ]);

  return {
    fee: plan,
    byCharge: new Map(charges.map((c) => [Number(c.id), {
      tax_behavior: c.tax_behavior, tax_rate_percent: c.tax_rate_percent,
    }])),
  };
}

async function loadPlanTaxTreatment(gymId: string, planId: number): Promise<TaxTreatment | null> {
  const { rows } = await db.query<{ tax_behavior: string | null; tax_rate_id: number | null }>(
    'SELECT tax_behavior, tax_rate_id FROM membership_plans WHERE id = ? AND gym_id = ?',
    [planId, gymId],
  );
  const plan = rows[0];
  if (!plan) return null;
  // The same two candidates `enrichPlan` reads: the Plan's own rate and the
  // gym's system rate. Which of the two applies is `selectPlanTaxRates()`'s
  // decision alone — no second "effective tax rate" resolution (#817).
  const { rows: rates } = await db.query<{
    id: number; name: string; rate_percent: string; is_system: number; deleted_at: Date | null;
  }>(
    `SELECT id, name, rate_percent, is_system, deleted_at
       FROM tax_rates
      WHERE gym_id = ? AND (id = ? OR (is_system = 1 AND deleted_at IS NULL))`,
    [gymId, plan.tax_rate_id],
  );
  const effective = selectPlanTaxRates(rates, plan.tax_rate_id).effective;
  return { tax_behavior: plan.tax_behavior, tax_rate_percent: effective ? effective.rate_percent : null };
}

const NOT_SIMULATED_REASON = 'This assigned plan is no longer billing, so there is nothing to forecast.';

/**
 * The Billing Event Forecast of one Assigned Plan. `null` when the assignment
 * is not this gym's at all — the caller answers 404 for that, which an
 * "unavailable" projection would hide.
 */
export async function assignedPlanBillingForecast(
  gymId: string, umId: number,
): Promise<BillingEventSimulationResult | null> {
  if (!Number.isInteger(umId) || umId <= 0) return null;
  const { rows } = await db.query(
    'SELECT id FROM user_memberships WHERE id = ? AND gym_id = ?', [umId, gymId],
  );
  if (rows.length === 0) return null;

  const loaded = await loadSimulationAssignments(gymId, { userMembershipId: umId });
  // The assignment exists but is `cancelled`/`expired` — outside
  // `SIMULATED_STATUSES`, so it bills nothing further.
  if (loaded.length === 0) return emptyBillingEventSimulation(NOT_SIMULATED_REASON);

  const { row, assignment } = loaded[0];
  const chargeIds = [
    ...assignment.planBenefits.map((b) => b.gymChargeId),
    ...assignment.services.map((s) => s.gymChargeId),
    ...assignment.promotions.flatMap((p) => p.grants.map((g) => g.gymChargeId)),
  ];
  const taxes = await loadTaxTreatments(gymId, row, chargeIds);

  return computeAssignmentBillingEventSimulation({
    assignment: grossSimulationAssignment(assignment, taxes),
  });
}
