import { db } from '../infra/db';
import { toPersonalFeeBenefit } from '../domain/personalFeeBenefit';
import { toPlanDuration, toPlanDurationCadence } from '../domain/planDuration';
import { toProductBenefit } from '../domain/productBenefitActions';
import { toSessionBenefitFrequency } from '../domain/sessionBenefitFrequency';
import {
  BillingUnit, ProductFrequency, SimulationAssignment, SimulationGrant, SimulationPlanBenefit,
  SimulationPromotion,
} from '../domain/billingSimulation';
import type { MembershipFeeBenefit } from '../domain/promotionApplication';
import type { ProductBenefitCategory } from '../domain/productClassification';
import { fetchLiveBenefits, membershipFeeBenefitsFromSnapshot } from './membership-promotions';
import { loadProductSetSimulationAssignment } from './product-set-configuration';

/**
 * #2125 stage 6 — the engine's input for a ProductSet version that holds **N** Membership
 * Plans: one `SimulationAssignment` per `plan_snapshots` row, read only from the plan snapshot
 * tables (migration 347), so the version's plans are summed by the engine exactly as the
 * Member-level simulation already sums several assignments.
 *
 * What belongs to a plan comes from its snapshot: the fee and Billing & Duration, the Plan's
 * included Products, and its Membership Plan Promotion applications with the Products they
 * grant (Oscar, #2125: a Promotion belongs to the plan snapshot it was applied to). What
 * belongs to the version rather than to any plan — recurring Product lines and a Promotion
 * aimed at a Product — rides on the first assignment, once, so it is billed once.
 *
 * A version with no plan snapshot (a plan-less version, or a Draft not yet synced) answers the
 * single assignment the version-keyed loader builds, so every caller gets a list either way.
 * With one plan the first element is that loader's output to the cent; a test pins it.
 */

type Exec = { query: typeof db.query };

const CATEGORIES: ProductBenefitCategory[] = ['session', 'oneoff', 'periodical'];
const PLAN_BENEFIT_TABLE: Record<ProductBenefitCategory, string> = {
  session: 'plan_session_snapshots',
  oneoff: 'plan_oneoff_snapshots',
  periodical: 'plan_periodical_snapshots',
};
const PROMOTION_GRANT_TABLE: Record<ProductBenefitCategory, string> = {
  session: 'plan_promotion_session_product_snapshots',
  oneoff: 'plan_promotion_oneoff_product_snapshots',
  periodical: 'plan_promotion_periodical_product_snapshots',
};

const toDateOnly = (v: unknown): string =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
const num = (v: unknown) => Math.max(0, Math.trunc(Number(v)) || 0);
const positiveQuantity = (v: unknown) => Math.max(1, Math.trunc(Number(v)) || 1);

async function loadPlanBenefits(exec: Exec, gymId: string, planSnapshotId: number): Promise<SimulationPlanBenefit[]> {
  const { rows } = await exec.query(
    CATEGORIES.map((category) => `
      SELECT '${category}' AS category, product_id, quantity, item_name, item_billing_frequency,
             unit_price, \`action\`, \`value\`,
             ${category === 'session' ? 'frequency' : 'NULL'} AS session_frequency
        FROM ${PLAN_BENEFIT_TABLE[category]} WHERE gym_id = ? AND plan_snapshot_id = ?`).join(' UNION ALL '),
    CATEGORIES.flatMap(() => [gymId, planSnapshotId]),
  );
  return (rows as any[]).map((b) => ({
    productId: b.product_id,
    name: b.item_name,
    category: b.category as ProductBenefitCategory,
    billingFrequency: (b.item_billing_frequency ?? null) as ProductFrequency | null,
    unitPrice: b.unit_price != null ? Number(b.unit_price) : 0,
    quantity: positiveQuantity(b.quantity),
    sessionFrequency: toSessionBenefitFrequency(b.session_frequency),
    benefit: toProductBenefit('plan', b.action, b.value),
  }));
}

async function loadPlanPromotions(exec: Exec, gymId: string, planSnapshotId: number): Promise<SimulationPromotion[]> {
  const { rows } = await exec.query(
    `SELECT pps.id, pps.promotion_id, pps.applied_at, pps.revoked_at, pps.snapshot,
            p.name AS promotion_name, p.free_months, p.paid_months, p.bonus_months, p.pay_beforehand_months
       FROM plan_promotion_snapshots pps
       LEFT JOIN promotions p ON p.id = pps.promotion_id
      WHERE pps.gym_id = ? AND pps.plan_snapshot_id = ? AND pps.status = 'applied'
      ORDER BY pps.id`,
    [gymId, planSnapshotId],
  );
  const ids = (rows as any[]).map((r) => Number(r.id));
  const grants = new Map<number, SimulationGrant[]>();
  if (ids.length > 0) {
    const marks = ids.map(() => '?').join(',');
    const { rows: grantRows } = await exec.query(
      CATEGORIES.map((category) => `
        SELECT '${category}' AS category, plan_promotion_snapshot_id, product_id, product_name, quantity,
               item_billing_frequency, unit_price, \`action\`, \`value\`
          FROM ${PROMOTION_GRANT_TABLE[category]}
         WHERE gym_id = ? AND plan_promotion_snapshot_id IN (${marks})`).join(' UNION ALL '),
      CATEGORIES.flatMap(() => [gymId, ...ids]),
    );
    for (const g of grantRows as any[]) {
      const list = grants.get(Number(g.plan_promotion_snapshot_id)) ?? [];
      list.push({
        productId: g.product_id ?? 0,
        name: g.product_name ?? 'Product',
        category: g.category as ProductBenefitCategory,
        billingFrequency: (g.item_billing_frequency ?? null) as ProductFrequency | null,
        unitPrice: g.unit_price != null ? Number(g.unit_price) : 0,
        quantity: positiveQuantity(g.quantity),
        benefit: toProductBenefit('promotion', g.action, g.value),
      });
      grants.set(Number(g.plan_promotion_snapshot_id), list);
    }
  }

  return Promise.all((rows as any[]).map(async (row): Promise<SimulationPromotion> => {
    const snap = row.snapshot as { name?: string; free_months?: number | null; paid_months?: number | null;
      bonus_months?: number | null } | null;
    const benefits = snap
      ? membershipFeeBenefitsFromSnapshot(snap as any)
      : (await fetchLiveBenefits(exec as any, row.promotion_id)).membership_fee_benefits;
    const membershipFeeBenefits: MembershipFeeBenefit[] = benefits.map((b: any): MembershipFeeBenefit => ({
      action: (b.action ?? null) as MembershipFeeBenefit['action'],
      value: b.value ?? null,
      enabled: !!b.enabled,
      durationMonths: b.duration_months ?? null,
    }));
    return {
      name: (snap?.name as string | undefined) ?? row.promotion_name ?? null,
      productTarget: false,
      appliedAt: toDateOnly(row.applied_at),
      revokedAt: row.revoked_at != null ? toDateOnly(row.revoked_at) : null,
      freeMonths: num(snap?.free_months ?? row.free_months),
      paidMonths: num(snap?.paid_months ?? row.paid_months),
      payBeforehandMonths: num(row.pay_beforehand_months),
      bonusMonths: num(snap?.bonus_months ?? row.bonus_months),
      membershipFeeBenefits,
      grants: grants.get(Number(row.id)) ?? [],
    } as SimulationPromotion;
  }));
}

/** One engine assignment per Membership Plan snapshot of the version (see the header). */
export async function loadProductSetSimulationAssignments(
  gymId: string, productSetId: number, exec: Exec = db,
): Promise<SimulationAssignment[]> {
  // The version-level parts (recurring lines, Product-target Promotions) and the fallback.
  const version = await loadProductSetSimulationAssignment(gymId, productSetId, exec);
  if (!version) return [];

  const { rows } = await exec.query(
    `SELECT s.id, s.membership_plan_id, s.starts_at, s.ends_at, s.membership_fee_price,
            s.free_periods, s.paid_periods, s.bonus_periods, s.pay_beforehand_periods, s.auto_renew,
            s.personal_fee_benefit_action, s.personal_fee_benefit_value,
            mp.name AS plan_name, sch.cadence_interval, sch.cadence_unit
       FROM plan_snapshots s
       LEFT JOIN membership_plans mp ON mp.id = s.membership_plan_id
       LEFT JOIN product_set_schedules sch ON sch.id = s.schedule_id
      WHERE s.gym_id = ? AND s.product_set_id = ?
      ORDER BY s.id`,
    [gymId, productSetId],
  );
  if (rows.length === 0) return [version];

  const productTarget = version.promotions.filter((p) => p.productTarget);
  const out: SimulationAssignment[] = [];
  for (const [index, row] of (rows as any[]).entries()) {
    const cadence = toPlanDurationCadence(row.cadence_interval, row.cadence_unit);
    const planPromotions = await loadPlanPromotions(exec, gymId, Number(row.id));
    out.push({
      // The engine's label for the contract; a plan snapshot has no assignment, so the
      // version's id stands in for the first plan and the snapshot's for any other.
      userMembershipId: index === 0 ? version.userMembershipId : Number(row.id),
      planName: row.plan_name ?? null,
      startsAt: toDateOnly(row.starts_at),
      endsAt: row.ends_at != null ? toDateOnly(row.ends_at) : null,
      membershipFeePrice: row.membership_fee_price != null ? Number(row.membership_fee_price) : null,
      recurringInterval: row.cadence_interval != null ? Number(row.cadence_interval) : null,
      recurringUnit: (row.cadence_unit ?? null) as BillingUnit | null,
      promotions: index === 0 ? [...planPromotions, ...productTarget] : planPromotions,
      services: index === 0 ? version.services : [],
      planBenefits: await loadPlanBenefits(exec, gymId, Number(row.id)),
      planDuration: toPlanDuration(
        row.free_periods, row.paid_periods, row.bonus_periods, row.pay_beforehand_periods,
        cadence, row.auto_renew,
      ),
      personalFeeBenefit: toPersonalFeeBenefit(row.personal_fee_benefit_action, row.personal_fee_benefit_value),
    });
  }
  return out;
}

/**
 * The schedule key each plan snapshot of the version is linked to, in the same order as
 * `loadProductSetSimulationAssignments()` answers (`NULL` where the snapshot has no schedule).
 * Empty for a version with no plan snapshot.
 */
export async function loadPlanSnapshotScheduleKeys(
  gymId: string, productSetId: number, exec: Exec = db,
): Promise<Array<string | null>> {
  const { rows } = await exec.query(
    `SELECT sch.schedule_key
       FROM plan_snapshots s
       LEFT JOIN product_set_schedules sch ON sch.id = s.schedule_id
      WHERE s.gym_id = ? AND s.product_set_id = ?
      ORDER BY s.id`,
    [gymId, productSetId],
  );
  return (rows as any[]).map((r) => (r.schedule_key != null ? String(r.schedule_key) : null));
}
