import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext } from '../infra/tenantContext';
import { loadPromotionApplications, regularMembershipFee } from './user-memberships';
import {
  BillingSimulationResult,
  BillingUnit,
  SellableItemFrequency,
  SimulationAssignment,
  SimulationGrant,
  SimulationPromotion,
  computeBillingSimulation,
} from '../domain/billingSimulation';
import { PlanDuration, toPlanDuration } from '../domain/planDuration';
import { SellableItemBenefitCategory } from '../domain/sellableItemClassification';
import { loadServicesForSimulation } from './user-membership-services';
import {
  ASSIGNMENT_CADENCE,
  loadPlanBenefitsForSimulation,
  loadPromotionGrantSnapshots,
} from './assigned-plan-snapshot';

/**
 * #629 (stage 1) — Billing Simulation.
 *
 * The DB half of the feature: it reads a Member's configuration and hands it
 * to the pure engine in `domain/billingSimulation.ts`. Nothing here writes —
 * the simulation creates no billing events, invoices, charges or payment
 * records (#629 §8); it is recomputed on every request, so it always reflects
 * the current Assigned Plan / Promotion configuration.
 *
 * Member-level rather than per-Assigned-Plan, per the #629 thread's Q4
 * answer: the engine lands once and renders where #634 wants it — a single
 * consolidated simulation for everything the Member pays for, not one per
 * Membership Plan card.
 *
 * #635 stage 3: every input is read from the assignment's own snapshot first
 * (§14 — "do not resolve the current Membership Plan or Promotion dynamically
 * when calculating billing for an existing assignment"). The live catalogue is
 * consulted only for an assignment that captured no snapshot, so repricing a
 * Plan, editing a Promotion or repricing a Sellable Item changes nothing here
 * for anyone already holding it.
 *
 * #635 stage 8: the assignment's frozen Billing & Duration joins those inputs
 * (`assignmentPlanDuration` below), so a Free Period or Bonus Duration actually
 * waives the Membership Fee instead of only being stored.
 */

// Statuses whose charges are still ahead of the Member. `cancelled`/`expired`
// assignments bill nothing further, so they contribute no future charges.
const SIMULATED_STATUSES = ['draft', 'awaiting_payment', 'active', 'paused'] as const;

// mysql2 may return DATE/DATETIME columns as Date objects rather than strings
// depending on the connection's timezone config (same note as
// user-memberships.ts's own helper) — the engine compares dates as strings.
function toDateOnly(v: unknown): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}

interface AssignmentRow {
  id: number;
  membership_plan_id: number | null;
  status: string;
  final_price: string | number | null;
  starts_at: unknown;
  ends_at: unknown;
  plan_name: string | null;
  /** Resolved in SQL: the assignment's frozen cadence, else its Plan's live one. */
  recurring_billing_interval: number | null;
  recurring_billing_unit: string | null;
  /** The regular Membership Fee frozen at assignment time — NULL for a pre-snapshot row. */
  membership_fee_price: string | number | null;
  /** 1 when any of the six snapshot columns is set; decides the benefit fallback. */
  has_billing_snapshot: number;
  /** #635 stage 8 — the assignment's own Billing & Duration, and its Plan's live one. */
  free_months: number | null;
  paid_months: number | null;
  bonus_months: number | null;
  plan_free_months: number | null;
  plan_paid_months: number | null;
  plan_bonus_months: number | null;
}

/**
 * The Billing & Duration this assignment bills on: the months frozen onto it,
 * or — only when it captured no snapshot at all — its Plan's live ones.
 *
 * The same all-or-nothing rule `loadPlanBenefitsForSimulation` applies, and for
 * the same reason: the columns are nullable, so a Plan that had no durations at
 * assignment time froze three NULLs. Falling back column by column would let a
 * Free Period *added to the Plan later* start waiving an existing assignment's
 * fee, which is exactly what §13 forbids. An assignment that captured anything
 * therefore reads its own columns, NULLs included (= no such period).
 */
function assignmentPlanDuration(row: AssignmentRow): PlanDuration {
  return Number(row.has_billing_snapshot) === 1
    ? toPlanDuration(row.free_months, row.paid_months, row.bonus_months)
    : toPlanDuration(row.plan_free_months, row.plan_paid_months, row.plan_bonus_months);
}

/**
 * Sellable Items granted by the given Promotions, from the three #550 benefit
 * tables, joined live to their catalogue row for the name, price and billing
 * frequency.
 *
 * Since #635 stage 3 this is only the **fallback**: an application that has
 * rows in `user_membership_promotion_*_snapshot` is priced from those instead
 * (`loadPromotionGrantSnapshots`), so editing or deleting the Promotion leaves
 * it alone (§16). Applications that predate the snapshot flow have nothing to
 * read, and still simulate from the Promotion as it stands today.
 * `gym_charges` is deliberately not filtered on `deleted_at`, so a granted
 * item still displays after it is retired.
 */
async function loadPromotionGrants(gymId: string, promotionIds: number[]): Promise<Map<number, SimulationGrant[]>> {
  const byPromotion = new Map<number, SimulationGrant[]>();
  if (promotionIds.length === 0) return byPromotion;

  const marks = promotionIds.map(() => '?').join(',');
  const select = (table: string, category: SellableItemBenefitCategory) => `
    SELECT '${category}' AS category, b.promotion_id, b.gym_charge_id, b.quantity,
           gc.name, gc.amount, gc.billing_frequency
    FROM ${table} b
    JOIN gym_charges gc ON gc.id = b.gym_charge_id
    WHERE b.gym_id = ? AND b.promotion_id IN (${marks})`;

  const params = [gymId, ...promotionIds, gymId, ...promotionIds, gymId, ...promotionIds];
  const { rows } = await db.query(
    [
      select('promotion_session', 'session'),
      select('promotion_oneoff', 'oneoff'),
      select('promotion_periodical', 'periodical'),
    ].join(' UNION ALL '),
    params,
  );

  for (const row of rows as any[]) {
    const grant: SimulationGrant = {
      gymChargeId: row.gym_charge_id,
      name: row.name ?? 'Sellable Item',
      category: row.category as SellableItemBenefitCategory,
      billingFrequency: (row.billing_frequency ?? null) as SellableItemFrequency | null,
      unitPrice: row.amount != null ? Number(row.amount) : 0,
      quantity: Math.max(1, Number(row.quantity) || 1),
    };
    const list = byPromotion.get(row.promotion_id) ?? [];
    list.push(grant);
    byPromotion.set(row.promotion_id, list);
  }
  return byPromotion;
}

/** Builds the engine's input for one Member and runs it. Read-only end to end. */
export async function computeMemberBillingSimulation(gymId: string, memberId: number): Promise<BillingSimulationResult> {
  const { rows } = await db.query<AssignmentRow>(
    `SELECT um.id, um.membership_plan_id, um.status, um.final_price, um.starts_at, um.ends_at,
            um.membership_fee_price,
            um.free_months, um.paid_months, um.bonus_months,
            p.name AS plan_name,
            p.free_months AS plan_free_months,
            p.paid_months AS plan_paid_months,
            p.bonus_months AS plan_bonus_months,
            ${ASSIGNMENT_CADENCE.interval()} AS recurring_billing_interval,
            ${ASSIGNMENT_CADENCE.unit()} AS recurring_billing_unit,
            (um.free_months IS NOT NULL OR um.paid_months IS NOT NULL
             OR um.bonus_months IS NOT NULL OR um.recurring_billing_interval IS NOT NULL
             OR um.recurring_billing_unit IS NOT NULL OR um.membership_fee_price IS NOT NULL
            ) AS has_billing_snapshot
     FROM user_memberships um
     LEFT JOIN membership_plans p ON p.id = um.membership_plan_id
     LEFT JOIN billing_policies bp
            ON bp.membership_plan_id = um.membership_plan_id AND bp.gym_id = um.gym_id
     WHERE um.gym_id = ? AND um.member_id = ?
       AND um.status IN (${SIMULATED_STATUSES.map(() => '?').join(',')})
     ORDER BY um.starts_at ASC, um.id ASC`,
    [gymId, memberId, ...SIMULATED_STATUSES],
  );

  const applicationsPerAssignment = await Promise.all(
    rows.map((row) => loadPromotionApplications(gymId, row.id).then((apps) => apps.filter((a) => a.status === 'applied'))),
  );
  const applications = applicationsPerAssignment.flat();
  // §16 — what the Promotion granted when it was applied. Only applications
  // with no snapshot at all fall back to the Promotion's live benefits.
  const grantsByApplication = await loadPromotionGrantSnapshots(gymId, applications.map((a) => a.id));
  const grantsByPromotion = await loadPromotionGrants(
    gymId,
    [...new Set(applications.filter((a) => !grantsByApplication.has(a.id)).map((a) => a.promotionId))],
  );
  // #631 — Additional Periodic Services attached to these assignments, priced
  // from the snapshot taken when each was attached (§17), live for a row that
  // predates migration 174.
  const servicesByAssignment = await loadServicesForSimulation(gymId, rows.map((row) => row.id));
  // #635 — the Plan's own One-off / Session / Period Benefits, as frozen onto
  // each assignment.
  const planBenefitsByAssignment = await loadPlanBenefitsForSimulation(gymId, rows.map((row) => ({
    id: row.id,
    membershipPlanId: row.membership_plan_id,
    hasBillingSnapshot: Number(row.has_billing_snapshot) === 1,
  })));

  const assignments: SimulationAssignment[] = await Promise.all(rows.map(async (row, i) => {
    const startsAt = toDateOnly(row.starts_at);
    const promotions: SimulationPromotion[] = applicationsPerAssignment[i].map((a) => ({
      name: a.name,
      appliedAt: a.appliedAt,
      revokedAt: a.revokedAt,
      freeMonths: a.freeMonths,
      paidMonths: a.paidMonths,
      payBeforehandMonths: a.payBeforehandMonths,
      bonusMonths: a.bonusMonths,
      membershipFeeBenefits: a.membershipFeeBenefits,
      grants: grantsByApplication.get(a.id) ?? grantsByPromotion.get(a.promotionId) ?? [],
    }));
    return {
      userMembershipId: row.id,
      planName: row.plan_name,
      startsAt,
      endsAt: row.ends_at != null ? toDateOnly(row.ends_at) : null,
      membershipFeePrice: await regularMembershipFee(gymId, row, startsAt),
      recurringInterval: row.recurring_billing_interval,
      recurringUnit: (row.recurring_billing_unit ?? null) as BillingUnit | null,
      promotions,
      services: servicesByAssignment.get(row.id) ?? [],
      planBenefits: planBenefitsByAssignment.get(row.id) ?? [],
      planDuration: assignmentPlanDuration(row),
    };
  }));

  return computeBillingSimulation({ assignments });
}

// Mounted at /user-memberships/member/:memberId/billing-simulation (app.ts),
// behind the same PAYMENTS module gate and payments.transactions feature flag
// as the rest of the Assigned Plans surface.
export const memberBillingSimulationRouter = Router({ mergeParams: true });

memberBillingSimulationRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const memberId = Number((req.params as any).memberId);
  if (!Number.isInteger(memberId) || memberId <= 0) {
    return res.status(400).json({ error: 'memberId must be a positive integer' });
  }

  const { rows } = await db.query(
    'SELECT id FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [memberId, gymId],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Member not found' });

  res.json(await computeMemberBillingSimulation(gymId, memberId));
});
