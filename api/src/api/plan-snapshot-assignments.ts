import { toLineDirectDiscount } from '../domain/lineDirectDiscount';
import { draftReferencePlanPromotionSql } from '../domain/draftPromotionApplication';
import { planSnapshotInheritedSql, promotionHolderSql } from './plan-snapshot-lines';
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
import { membershipFeeUnitsSql } from '../domain/membershipFeeScope';
import { feeMemberDiscountsSql, parseFeeMemberDiscounts } from '../domain/feeMemberDiscounts';
import { loadLivePromotionGrants } from './assigned-plan-snapshot';

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
             unit_price, \`action\`, \`value\`, direct_discount_percent, assigned_member_id,
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
    directDiscountPercent: toLineDirectDiscount(b.direct_discount_percent),
    assignedMemberId: b.assigned_member_id != null ? Number(b.assigned_member_id) : null,
  }));
}

async function loadPlanPromotions(exec: Exec, gymId: string, planSnapshotId: number): Promise<SimulationPromotion[]> {
  const { rows } = await exec.query(
    `SELECT pps.id, pps.promotion_id, pps.applied_at, pps.revoked_at, pps.snapshot,
            ${draftReferencePlanPromotionSql('pps')} AS unconfirmed,
            p.name AS promotion_name, p.free_months, p.paid_months, p.bonus_months, p.pay_beforehand_months
       FROM plan_promotion_snapshots pps
       LEFT JOIN promotions p ON p.id = pps.promotion_id
      WHERE pps.gym_id = ? AND pps.plan_snapshot_id = ${promotionHolderSql('?')} AND pps.status = 'applied'
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
  // #2833: an application on a Draft that is not confirmed yet has no snapshot — neither its own
  // nor the grant rows — and is priced from the Promotion as it stands now (any working copy written
  // before that ticket is ignored), exactly as `loadPromotionGrantSnapshots()` reads it.
  const unconfirmed = (rows as any[]).filter((r) => Number(r.unconfirmed) === 1);
  if (unconfirmed.length > 0) {
    const live = await loadLivePromotionGrants(
      gymId, [...new Set(unconfirmed.map((r) => Number(r.promotion_id)))], exec);
    for (const r of unconfirmed) grants.set(Number(r.id), live.get(Number(r.promotion_id)) ?? []);
  }

  return Promise.all((rows as any[]).map(async (row): Promise<SimulationPromotion> => {
    const snap = (Number(row.unconfirmed) === 1 ? null : row.snapshot) as { name?: string;
      free_months?: number | null; paid_months?: number | null; bonus_months?: number | null } | null;
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
    `${PLAN_ROW_SELECT}
      WHERE s.gym_id = ? AND psj.product_set_id = ? AND psj.entitlement_only = 0
      ORDER BY psj.id`,
    [gymId, productSetId],
  );
  if (rows.length === 0) return [version];

  const productTarget = version.promotions.filter((p) => p.productTarget);
  const out: SimulationAssignment[] = [];
  for (const [index, row] of (rows as any[]).entries()) {
    out.push(await planRowAssignment(exec, gymId, row, index, version, productTarget));
  }
  return out;
}

const PLAN_ROW_SELECT = `SELECT s.id, s.schedule_id, COALESCE(cf.anchor_plan_snapshot_id, cf.id, s.anchor_plan_snapshot_id, s.id) AS plan_instance_key, s.membership_plan_id, s.starts_at, s.ends_at, s.previous_end_date, s.membership_fee_price,
            s.free_periods, s.paid_periods, s.bonus_periods, s.pay_beforehand_periods, s.auto_renew,
            s.personal_fee_benefit_action, s.personal_fee_benefit_value,
            mp.name AS plan_name, sch.cadence_interval, sch.cadence_unit, sch.anchor_date,
            ${membershipFeeUnitsSql('s')} AS membership_fee_units,
            ${feeMemberDiscountsSql('s')} AS fee_member_discounts
       FROM product_set_plan_snapshots psj
       JOIN plan_snapshots s ON s.id = psj.plan_snapshot_id
       LEFT JOIN plan_snapshots cf ON cf.id = s.copied_from_plan_snapshot_id
       LEFT JOIN membership_plans mp ON mp.id = s.membership_plan_id
       LEFT JOIN product_set_schedules sch ON sch.id = s.schedule_id`;

/** One plan snapshot row as the engine's assignment; the first carries the version's own parts. */
async function planRowAssignment(
  exec: Exec, gymId: string, row: any, index: number,
  version: SimulationAssignment | null, productTarget: SimulationPromotion[],
): Promise<SimulationAssignment> {
  const cadence = toPlanDurationCadence(row.cadence_interval, row.cadence_unit);
  const planPromotions = await loadPlanPromotions(exec, gymId, Number(row.id));
  return {
    // The engine's label for the contract; a plan snapshot has no assignment, so the
    // version's id stands in for the first plan and the snapshot's for any other.
    userMembershipId: index === 0 ? version!.userMembershipId : Number(row.id),
    planName: row.plan_name ?? null,
    // #3303 — the instance's identity across versions, never its Membership Plan or its name: the
    // assignment it continues (a copy-on-write or an ⋮ → Edit Draft keeps its source's), else its own.
    planInstanceKey: String(row.plan_instance_key),
    startsAt: toDateOnly(row.starts_at),
    endsAt: row.ends_at != null ? toDateOnly(row.ends_at) : null,
    membershipFeePrice: row.membership_fee_price != null ? Number(row.membership_fee_price) : null,
    recurringInterval: row.cadence_interval != null ? Number(row.cadence_interval) : null,
    recurringUnit: (row.cadence_unit ?? null) as BillingUnit | null,
    promotions: index === 0 ? [...planPromotions, ...productTarget] : planPromotions,
    services: index === 0 ? version!.services : [],
    planBenefits: await loadPlanBenefits(exec, gymId, Number(row.id)),
    planDuration: toPlanDuration(
      row.free_periods, row.paid_periods, row.bonus_periods, row.pay_beforehand_periods,
      cadence, row.auto_renew,
    ),
    personalFeeBenefit: toPersonalFeeBenefit(row.personal_fee_benefit_action, row.personal_fee_benefit_value),
    // #2834 — the snapshot's own scope over its own beneficiaries.
    membershipFeeUnits: Number(row.membership_fee_units ?? 1),
    membershipFeeMemberDiscounts: parseFeeMemberDiscounts(row.fee_member_discounts),
    // A plan whose start falls between two dates of its schedule (a plan added to a schedule
    // that was already running, or — since #2125 M5c — any plan starting off its cadence's
    // calendar grid) pays a prorated first stretch and then bills on the schedule's dates. An
    // inherited plan aligns too, so a later version keeps billing on the grid its schedule is
    // anchored on; its prorated stretch is in the past and is never materialised again.
    ...(row.anchor_date != null && toDateOnly(row.anchor_date) < toDateOnly(row.starts_at)
      ? { alignTo: toDateOnly(row.anchor_date) } : {}),
  };
}

/**
 * #3114 stage 3 — the plans the owner marked `to_be_reactivated` that this uncommitted version
 * carries (an entitlement-only link: a plan running to its end date), as the engine will bill them
 * once the reactivation is committed: open-ended (the commit clears `ends_at`). Only the Draft's
 * forecast reads this; the initial charge never does (Option A: no extra charge for a period
 * already paid).
 *
 * #3507 — `coveredDates` are the periods of the plan's schedule that already hold an obligation
 * (`billing_events.schedule_id` / `period_start`, or a line's since #3445 stage 2): exactly the
 * periods `materialiseScheduledEvents()` leaves alone when the reactivation is committed, so the
 * forecast drops those and nothing else. It used to drop every date up to the plan's old end
 * date (`previous_end_date`), which both hid periods the commit does generate and, for a plan
 * paid further ahead than the forecast's two cycles, hid the reactivated plan altogether.
 */
export async function loadPendingReactivationAssignments(
  gymId: string, productSetId: number, exec: Exec = db,
): Promise<Array<{ assignment: SimulationAssignment; coveredDates: string[] }>> {
  const { rows } = await exec.query(
    `${PLAN_ROW_SELECT}
       JOIN product_sets ps ON ps.id = psj.product_set_id
      WHERE s.gym_id = ? AND psj.product_set_id = ? AND psj.entitlement_only = 1
        AND s.status = 'to_be_reactivated' AND ps.status IN ('in_cart', 'pending_payment')
      ORDER BY psj.id`,
    [gymId, productSetId],
  );
  const out: Array<{ assignment: SimulationAssignment; coveredDates: string[] }> = [];
  for (const row of rows as any[]) {
    const assignment = await planRowAssignment(exec, gymId, row, 1, null, []);
    out.push({
      assignment: { ...assignment, endsAt: null },
      coveredDates: row.schedule_id != null ? await scheduleCoveredDates(exec, gymId, Number(row.schedule_id)) : [],
    });
  }
  return out;
}

/** The periods of one schedule that already hold an obligation, on the event row or on a line. */
async function scheduleCoveredDates(exec: Exec, gymId: string, scheduleId: number): Promise<string[]> {
  const { rows } = await exec.query(
    `SELECT DATE_FORMAT(period_start, '%Y-%m-%d') AS d FROM billing_events
      WHERE gym_id = ? AND schedule_id = ? AND period_start IS NOT NULL
     UNION
     SELECT DATE_FORMAT(bl.period_start, '%Y-%m-%d') AS d FROM billing_event_lines bl
       JOIN billing_events be ON be.id = bl.billing_event_id
      WHERE be.gym_id = ? AND bl.schedule_id = ? AND bl.period_start IS NOT NULL`,
    [gymId, scheduleId, gymId, scheduleId],
  );
  return (rows as any[]).map((r) => String(r.d));
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
       FROM product_set_plan_snapshots psj
       JOIN plan_snapshots s ON s.id = psj.plan_snapshot_id
       LEFT JOIN product_set_schedules sch ON sch.id = s.schedule_id
      WHERE s.gym_id = ? AND psj.product_set_id = ? AND psj.entitlement_only = 0
      ORDER BY psj.id`,
    [gymId, productSetId],
  );
  return (rows as any[]).map((r) => (r.schedule_key != null ? String(r.schedule_key) : null));
}

/** Whether each plan snapshot of the version is an inherited copy, in the loader's order (#2125 stage 14). */
export async function loadPlanSnapshotInheritance(
  gymId: string, productSetId: number, exec: Exec = db,
): Promise<boolean[]> {
  const { rows } = await exec.query(
    `SELECT ${planSnapshotInheritedSql('s', 'psj.product_set_id')} AS is_inherited
       FROM product_set_plan_snapshots psj JOIN plan_snapshots s ON s.id = psj.plan_snapshot_id
      WHERE s.gym_id = ? AND psj.product_set_id = ? AND psj.entitlement_only = 0 ORDER BY psj.id`, [gymId, productSetId]);
  return (rows as any[]).map((r) => Number(r.is_inherited) === 1);
}
