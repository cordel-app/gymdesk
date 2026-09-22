import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext } from '../infra/tenantContext';
import { effectivePrice, loadPromotionApplications } from './user-memberships';
import {
  BillingSimulationResult,
  BillingUnit,
  SellableItemFrequency,
  SimulationAssignment,
  SimulationGrant,
  SimulationPromotion,
  computeBillingSimulation,
} from '../domain/billingSimulation';
import { SellableItemBenefitCategory } from '../domain/sellableItemClassification';
import { loadServicesForSimulation } from './user-membership-services';

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
  recurring_billing_interval: number | null;
  recurring_billing_unit: string | null;
}

/**
 * Sellable Items granted by the given Promotions, from the three #550
 * benefit tables, joined live to their catalogue row for the name, price and
 * billing frequency.
 *
 * Read live rather than from the `user_membership_promotion_*_snapshot`
 * tables (migration 156): those are created but nothing writes to them yet —
 * the assignment-time snapshot flow is an explicit follow-up to #550. When it
 * lands, this loader should prefer a snapshot row over the live catalogue,
 * exactly as `loadPromotionApplications` already does for Membership Fee
 * benefits. `gym_charges` is deliberately not filtered on `deleted_at`, so a
 * granted item still displays after it is retired (mirrors
 * `loadChargeBenefitsSnapshot`).
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

/**
 * The regular (pre-Promotion) Membership Fee for an assignment: the Plan's
 * price window covering its start date.
 *
 * `user_memberships.base_price` is not usable as the regular price — it is
 * snapshotted from `effectivePrice()`, which has returned a constant 0 for
 * that field since `membership_plans.base_price` was dropped in migration
 * 058. When the Plan has no price window at all, the assignment's own
 * `final_price` is the last resort, so a legacy row still simulates something
 * rather than a column of zeros.
 */
async function regularMembershipFee(gymId: string, row: AssignmentRow, startsAt: string): Promise<number | null> {
  if (row.membership_plan_id != null) {
    const eff = await effectivePrice(row.membership_plan_id, gymId, startsAt);
    if (eff && eff.plan_price_id != null) return eff.price;
  }
  return row.final_price != null ? Number(row.final_price) : null;
}

/** Builds the engine's input for one Member and runs it. Read-only end to end. */
export async function computeMemberBillingSimulation(gymId: string, memberId: number): Promise<BillingSimulationResult> {
  const { rows } = await db.query<AssignmentRow>(
    `SELECT um.id, um.membership_plan_id, um.status, um.final_price, um.starts_at, um.ends_at,
            p.name AS plan_name,
            bp.recurring_billing_interval, bp.recurring_billing_unit
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
  const grantsByPromotion = await loadPromotionGrants(
    gymId,
    [...new Set(applicationsPerAssignment.flat().map((a) => a.promotionId))],
  );
  // #631 — Additional Periodic Services attached to these assignments. Read
  // live (name, price, frequency from `gym_charges`) like the Promotion grants
  // above, so an item's price change is reflected the next time the simulation
  // runs rather than being frozen at attachment time.
  const servicesByAssignment = await loadServicesForSimulation(gymId, rows.map((row) => row.id));

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
      grants: grantsByPromotion.get(a.promotionId) ?? [],
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
