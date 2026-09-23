import { db, Tx } from '../infra/db';
import {
  SellableItemBenefitCategory,
  planBenefitTableForCategory,
} from '../domain/sellableItemClassification';
// Type-only: `domain/billingSimulation` imports `advanceBillingDate` from
// `api/billing`, which imports ASSIGNMENT_CADENCE from here — an `import type`
// is erased, so the three modules never form a runtime cycle.
import type {
  SellableItemFrequency,
  SimulationGrant,
  SimulationPlanBenefit,
} from '../domain/billingSimulation';

/**
 * #635 stage 2 — the Assigned Membership Plan's own snapshot of the commercial
 * configuration it was assigned with (migration 174).
 *
 * §11–§14: once assigned, the assignment is its own contract. Everything that
 * decides what it bills is copied onto it at assignment time:
 *
 *     Membership Plan ──assign──▶ Assigned Plan snapshot
 *                                   ├── Billing & Duration (free/paid/bonus)
 *                                   ├── billing cadence (interval + unit)
 *                                   ├── regular Membership Fee
 *                                   └── One-off / Session / Period Benefits
 *                                         + each item's name, type,
 *                                           frequency, price and currency
 *
 * so a later edit to the Plan, its billing policy, its price windows or a
 * Sellable Item cannot reach an assignment that already exists (§13, §17).
 *
 * #635 stage 3 makes billing *read* it. Everything that prices an existing
 * assignment now resolves the snapshot first and only falls back to the live
 * catalogue for an assignment that has none — a row created before migration
 * 174 that the backfill could not reach, or one whose Plan had nothing to
 * copy. The fallbacks live next to the loaders below (`ASSIGNMENT_CADENCE`,
 * `loadPlanBenefitsForSimulation`, `loadPromotionGrantSnapshots`), so every
 * caller resolves them the same way rather than re-deriving the rule.
 */

/**
 * `gym_charges.name` and `.type` are nullable — a system charge displays under
 * its `charge_types` name — while the snapshot columns are NOT NULL. Copying
 * them raw would 500 the assignment for any Plan carrying such an item, so
 * both are resolved here and in migration 174's backfill with the identical
 * fallback.
 */
const ITEM_NAME_EXPR = "COALESCE(gc.name, ct.name, CONCAT('Sellable Item #', gc.id))";
const ITEM_TYPE_EXPR = "COALESCE(gc.type, 'other')";

export const BENEFIT_TABLE_BY_CATEGORY: Record<SellableItemBenefitCategory, string> = {
  session: 'user_membership_session',
  oneoff: 'user_membership_oneoff',
  periodical: 'user_membership_periodical',
};

/** One snapshotted benefit row, as the API serves it. */
export interface AssignedPlanBenefitRow {
  id: number;
  user_membership_id: number;
  gym_charge_id: number;
  quantity: number;
  item_name: string;
  item_type: string;
  item_billing_frequency: string | null;
  unit_price: number;
  currency: string | null;
}

/** The assignment's frozen Billing & Duration, cadence and regular fee. */
export interface AssignedPlanBillingSnapshot {
  free_months: number | null;
  paid_months: number | null;
  bonus_months: number | null;
  recurring_billing_interval: number | null;
  recurring_billing_unit: string | null;
  membership_fee_price: number | null;
}

export interface AssignedPlanSnapshot extends AssignedPlanBillingSnapshot {
  session_benefits: AssignedPlanBenefitRow[];
  oneoff_benefits: AssignedPlanBenefitRow[];
  periodical_benefits: AssignedPlanBenefitRow[];
  /**
   * False when nothing was captured at all — an assignment made before
   * migration 174 that the backfill could not fill (no Plan to copy from), or
   * one whose Plan had nothing to copy (no durations, no billing policy, no
   * price window and no benefits). Stage 3's billing cutover resolves those
   * rows against the live catalogue rather than reading an empty snapshot as
   * "this assignment bills nothing".
   */
  snapshot_captured: boolean;
}

const CATEGORIES: SellableItemBenefitCategory[] = ['session', 'oneoff', 'periodical'];

function shapeBenefit(row: any): AssignedPlanBenefitRow {
  return {
    id: row.id,
    user_membership_id: row.user_membership_id,
    gym_charge_id: row.gym_charge_id,
    quantity: Number(row.quantity),
    item_name: row.item_name,
    item_type: row.item_type,
    item_billing_frequency: row.item_billing_frequency ?? null,
    unit_price: row.unit_price != null ? Number(row.unit_price) : 0,
    currency: row.currency ?? null,
  };
}

/**
 * Captures the Plan's commercial configuration onto a freshly created
 * assignment. Runs inside the caller's transaction, so an assignment can never
 * commit half-snapshotted.
 *
 * `membershipFeePrice` is the *regular* (pre-Promotion, pre-discount) price the
 * caller already resolved with `effectivePrice()`. It is passed in rather than
 * re-read here because the caller may have no price window at all, in which
 * case there is no regular price to freeze and the column stays NULL —
 * `final_price` is not a substitute, being the agreed price after promotions
 * and manual discounts.
 *
 * Benefit rows carry the Sellable Item's price as it is now: the item itself
 * may be repriced, renamed or retired later without touching what was agreed
 * (§17). `INSERT ... SELECT` keeps each section a single statement, and
 * `gym_charges` is not filtered on `deleted_at` — an item already attached to
 * the Plan is part of the agreement even if it is retired in the same breath.
 */
export async function snapshotAssignedPlan(tx: Tx, params: {
  gymId: string;
  userMembershipId: number;
  membershipPlanId: number | null;
  membershipFeePrice: number | null;
}): Promise<void> {
  const { gymId, userMembershipId, membershipPlanId, membershipFeePrice } = params;
  if (membershipPlanId == null) return;

  const { rows: planRows } = await tx.query(
    `SELECT p.free_months, p.paid_months, p.bonus_months,
            bp.recurring_billing_interval, bp.recurring_billing_unit
     FROM membership_plans p
     LEFT JOIN billing_policies bp ON bp.membership_plan_id = p.id AND bp.gym_id = p.gym_id
     WHERE p.id = ? AND p.gym_id = ?`,
    [membershipPlanId, gymId],
  );
  const plan = planRows[0] ?? {};

  await tx.query(
    `UPDATE user_memberships
     SET free_months = ?, paid_months = ?, bonus_months = ?,
         recurring_billing_interval = ?, recurring_billing_unit = ?, membership_fee_price = ?
     WHERE id = ? AND gym_id = ?`,
    [
      plan.free_months ?? null, plan.paid_months ?? null, plan.bonus_months ?? null,
      plan.recurring_billing_interval ?? null, plan.recurring_billing_unit ?? null,
      membershipFeePrice ?? null,
      userMembershipId, gymId,
    ],
  );

  for (const category of CATEGORIES) {
    const target = BENEFIT_TABLE_BY_CATEGORY[category];
    const source = planBenefitTableForCategory(category);
    await tx.query(
      `INSERT INTO ${target}
         (gym_id, user_membership_id, gym_charge_id, quantity,
          item_name, item_type, item_billing_frequency, unit_price, currency)
       SELECT ?, ?, b.gym_charge_id, b.quantity,
              ${ITEM_NAME_EXPR}, ${ITEM_TYPE_EXPR},
              gc.billing_frequency, COALESCE(gc.amount, 0), gc.currency
       FROM ${source} b
       JOIN gym_charges gc ON gc.id = b.gym_charge_id
       LEFT JOIN charge_types ct ON ct.id = gc.charge_type_id
       WHERE b.membership_plan_id = ? AND b.gym_id = ?`,
      [gymId, userMembershipId, membershipPlanId, gymId],
    );
  }
}

/** The snapshot of one assignment, for the expanded card and (in stage 3) billing. */
export async function loadAssignedPlanSnapshot(
  gymId: string, umId: number,
): Promise<AssignedPlanSnapshot> {
  const [{ rows: umRows }, ...benefitResults] = await Promise.all([
    db.query(
      `SELECT free_months, paid_months, bonus_months,
              recurring_billing_interval, recurring_billing_unit, membership_fee_price
       FROM user_memberships WHERE id = ? AND gym_id = ?`,
      [umId, gymId],
    ),
    ...CATEGORIES.map((category) => db.query(
      `SELECT * FROM ${BENEFIT_TABLE_BY_CATEGORY[category]}
       WHERE user_membership_id = ? AND gym_id = ? ORDER BY item_name ASC, id ASC`,
      [umId, gymId],
    )),
  ]);
  const um = umRows[0] ?? {};
  const [session, oneoff, periodical] = benefitResults.map((r) => r.rows.map(shapeBenefit));

  const billing: AssignedPlanBillingSnapshot = {
    free_months: um.free_months ?? null,
    paid_months: um.paid_months ?? null,
    bonus_months: um.bonus_months ?? null,
    recurring_billing_interval: um.recurring_billing_interval ?? null,
    recurring_billing_unit: um.recurring_billing_unit ?? null,
    membership_fee_price: um.membership_fee_price != null ? Number(um.membership_fee_price) : null,
  };

  return {
    ...billing,
    session_benefits: session,
    oneoff_benefits: oneoff,
    periodical_benefits: periodical,
    snapshot_captured:
      Object.values(billing).some((v) => v != null)
      || session.length > 0 || oneoff.length > 0 || periodical.length > 0,
  };
}

/* ── Stage 3: billing reads the snapshot ─────────────────────────────────── */

/**
 * The billing cadence of an assignment, in SQL: the cadence frozen onto the
 * assignment, falling back to its Plan's live `billing_policies` row only for
 * an assignment that has none.
 *
 * Every query that projects or advances a billing date uses this, so editing a
 * Plan's billing frequency can never move an existing assignment's schedule
 * (§13) — and so the nightly run, the Billing Events page, the Payments
 * dashboard and the simulation can never disagree about the cadence. The
 * joined `billing_policies` row must therefore be a LEFT JOIN at every call
 * site: a Plan whose policy was deleted still bills its existing assignments.
 */
export const ASSIGNMENT_CADENCE = {
  interval: (um = 'um', bp = 'bp') => `COALESCE(${um}.recurring_billing_interval, ${bp}.recurring_billing_interval)`,
  unit: (um = 'um', bp = 'bp') => `COALESCE(${um}.recurring_billing_unit, ${bp}.recurring_billing_unit)`,
};

function toFrequency(v: unknown): SellableItemFrequency | null {
  return (v ?? null) as SellableItemFrequency | null;
}

function positiveQuantity(v: unknown): number {
  return Math.max(1, Math.trunc(Number(v)) || 1);
}

/**
 * The Plan benefit sections that each of these assignments bills, keyed by
 * assignment id: its own frozen rows, or — only when it captured no snapshot
 * at all — the Plan's live sections, so a pre-migration-174 assignment still
 * simulates what it is actually entitled to rather than nothing.
 *
 * `hasBillingSnapshot` comes from the caller's own `user_memberships` row (any
 * of the six snapshot columns set): an assignment that captured a cadence but
 * whose Plan carried no benefits must read back as "no benefits", not fall
 * through to a Plan that has gained some since.
 */
export async function loadPlanBenefitsForSimulation(
  gymId: string,
  assignments: { id: number; membershipPlanId: number | null; hasBillingSnapshot: boolean }[],
): Promise<Map<number, SimulationPlanBenefit[]>> {
  const byAssignment = new Map<number, SimulationPlanBenefit[]>();
  if (assignments.length === 0) return byAssignment;

  const ids = assignments.map((a) => a.id);
  const marks = ids.map(() => '?').join(',');
  const { rows } = await db.query(
    CATEGORIES.map((category) => `
      SELECT '${category}' AS category, user_membership_id, gym_charge_id, quantity,
             item_name, item_billing_frequency, unit_price
      FROM ${BENEFIT_TABLE_BY_CATEGORY[category]}
      WHERE gym_id = ? AND user_membership_id IN (${marks})`).join(' UNION ALL '),
    CATEGORIES.flatMap(() => [gymId, ...ids]),
  );
  for (const row of rows as any[]) {
    const list = byAssignment.get(row.user_membership_id) ?? [];
    list.push({
      gymChargeId: row.gym_charge_id,
      name: row.item_name,
      category: row.category as SellableItemBenefitCategory,
      billingFrequency: toFrequency(row.item_billing_frequency),
      unitPrice: row.unit_price != null ? Number(row.unit_price) : 0,
      quantity: positiveQuantity(row.quantity),
    });
    byAssignment.set(row.user_membership_id, list);
  }

  const legacy = assignments.filter(
    (a) => a.membershipPlanId != null && !a.hasBillingSnapshot && !byAssignment.has(a.id),
  );
  if (legacy.length === 0) return byAssignment;

  const planIds = [...new Set(legacy.map((a) => a.membershipPlanId as number))];
  const planMarks = planIds.map(() => '?').join(',');
  const { rows: liveRows } = await db.query(
    CATEGORIES.map((category) => `
      SELECT '${category}' AS category, b.membership_plan_id, b.gym_charge_id, b.quantity,
             ${ITEM_NAME_EXPR} AS item_name, gc.billing_frequency, gc.amount
      FROM ${planBenefitTableForCategory(category)} b
      JOIN gym_charges gc ON gc.id = b.gym_charge_id
      LEFT JOIN charge_types ct ON ct.id = gc.charge_type_id
      WHERE b.gym_id = ? AND b.membership_plan_id IN (${planMarks})`).join(' UNION ALL '),
    CATEGORIES.flatMap(() => [gymId, ...planIds]),
  );
  const livePerPlan = new Map<number, SimulationPlanBenefit[]>();
  for (const row of liveRows as any[]) {
    const list = livePerPlan.get(row.membership_plan_id) ?? [];
    list.push({
      gymChargeId: row.gym_charge_id,
      name: row.item_name,
      category: row.category as SellableItemBenefitCategory,
      billingFrequency: toFrequency(row.billing_frequency),
      unitPrice: row.amount != null ? Number(row.amount) : 0,
      quantity: positiveQuantity(row.quantity),
    });
    livePerPlan.set(row.membership_plan_id, list);
  }
  for (const a of legacy) {
    const live = livePerPlan.get(a.membershipPlanId as number);
    if (live) byAssignment.set(a.id, live);
  }
  return byAssignment;
}

const PROMOTION_GRANT_SNAPSHOT_TABLE: Record<SellableItemBenefitCategory, string> = {
  session: 'user_membership_promotion_session_snapshot',
  oneoff: 'user_membership_promotion_oneoff_snapshot',
  periodical: 'user_membership_promotion_periodical_snapshot',
};

/**
 * What each Promotion application granted, as it was when the Promotion was
 * applied (`snapshotPromotionGrants()` in `membership-promotions.ts`), keyed by
 * `user_membership_promotions.id`.
 *
 * An application with no rows at all is not in the map, which is the caller's
 * signal to read the Promotion's live benefits instead — editing or deleting a
 * Promotion must not move an assignment that has a snapshot (§16), but an
 * application that predates the snapshot flow still has to simulate something.
 * A snapshot row whose `unit_price` is NULL (its Sellable Item was already
 * gone when migration 174 backfilled) prices at 0 rather than reaching for a
 * live row that no longer exists.
 */
export async function loadPromotionGrantSnapshots(
  gymId: string, applicationIds: number[],
): Promise<Map<number, SimulationGrant[]>> {
  const byApplication = new Map<number, SimulationGrant[]>();
  if (applicationIds.length === 0) return byApplication;

  const marks = applicationIds.map(() => '?').join(',');
  const { rows } = await db.query(
    CATEGORIES.map((category) => `
      SELECT '${category}' AS category, user_membership_promotion_id, gym_charge_id,
             gym_charge_name, quantity, item_billing_frequency, unit_price
      FROM ${PROMOTION_GRANT_SNAPSHOT_TABLE[category]}
      WHERE gym_id = ? AND user_membership_promotion_id IN (${marks})`).join(' UNION ALL '),
    CATEGORIES.flatMap(() => [gymId, ...applicationIds]),
  );
  for (const row of rows as any[]) {
    const list = byApplication.get(row.user_membership_promotion_id) ?? [];
    list.push({
      // The snapshot keeps the item's identity even after it is deleted
      // (`gym_charge_id` is ON DELETE SET NULL there); 0 groups those under a
      // line that no longer points at a catalogue row.
      gymChargeId: row.gym_charge_id ?? 0,
      name: row.gym_charge_name ?? 'Sellable Item',
      category: row.category as SellableItemBenefitCategory,
      billingFrequency: toFrequency(row.item_billing_frequency),
      unitPrice: row.unit_price != null ? Number(row.unit_price) : 0,
      quantity: positiveQuantity(row.quantity),
    });
    byApplication.set(row.user_membership_promotion_id, list);
  }
  return byApplication;
}
