import { ASSIGNMENT_CONFIG_JOIN, assignmentConfig, assignmentPlanSnapshotId } from './assignment-config';
import { db, Tx } from '../infra/db';
import { toPlanBenefitMandatory } from '../domain/planBenefitMandatory';
import { coveredMemberCount } from '../domain/assignedBenefitQuantity';
import { PersonalFeeBenefit, toPersonalFeeBenefit } from '../domain/personalFeeBenefit';
import { toPlanDurationRepeats } from '../domain/planDuration';
import { PlanBenefitPrices } from '../domain/planBenefitPrices';
import { productBenefitPrices } from './product-benefit-pricing';
import { ProductBenefit, toProductBenefit } from '../domain/productBenefitActions';
import {
  SessionBenefitFrequency,
  toSessionBenefitFrequency,
} from '../domain/sessionBenefitFrequency';
import {
  ProductBenefitCategory,
  planBenefitTableForCategory,
} from '../domain/productClassification';
// Type-only: `domain/billingSimulation` imports `advanceBillingDate` from
// `api/billing`, which imports ASSIGNMENT_CADENCE from here — an `import type`
// is erased, so the three modules never form a runtime cycle.
import type {
  ProductFrequency,
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
 *                                   ├── Billing & Duration (free/prepaid/paid/bonus)
 *                                   ├── billing cadence (interval + unit)
 *                                   ├── regular Membership Fee
 *                                   └── One-off / Session / Period Benefits
 *                                         + each item's name, type,
 *                                           frequency, price and currency
 *
 * so a later edit to the Plan, its billing policy, its price windows or a
 * Product cannot reach an assignment that already exists (§13, §17).
 *
 * #635 stage 3 makes billing *read* it. Everything that prices an existing
 * assignment now resolves the snapshot first and only falls back to the live
 * catalogue for an assignment that has none — a row created before migration
 * 174 that the backfill could not reach, or one whose Plan had nothing to
 * copy. The fallbacks live next to the loaders below (`ASSIGNMENT_CADENCE`,
 * `loadPlanBenefitsForSimulation`, `loadPromotionGrantSnapshots`), so every
 * caller resolves them the same way rather than re-deriving the rule.
 *
 * #635 stage 6 lets staff *edit* it: `writeAssignedPlanBenefitSection` and the
 * Billing & Duration route in `user-memberships.ts` change this assignment's
 * own rows and nothing else (§15), and `materialiseAssignedPlanSnapshot` first
 * writes down what an assignment that never captured one resolves live today,
 * so an edit can never leave it half-snapshotted.
 */

/**
 * `products.name` and `.type` are nullable — a system charge displays under
 * its `charge_types` name — while the snapshot columns are NOT NULL. Copying
 * them raw would 500 the assignment for any Plan carrying such an item, so
 * both are resolved here and in migration 174's backfill with the identical
 * fallback.
 */
const ITEM_NAME_EXPR = "COALESCE(gc.name, ct.name, CONCAT('Product #', gc.id))";
const ITEM_TYPE_EXPR = "COALESCE(gc.type, 'other')";

/**
 * #2125 stage 11 — the plan snapshot tables an assignment's included Products are read from
 * (keyed by the plan snapshot, so a version holding several plans keeps each one's own lines).
 */
const PLAN_SNAPSHOT_TABLE_BY_CATEGORY: Record<ProductBenefitCategory, string> = {
  session: 'plan_session_snapshots',
  oneoff: 'plan_oneoff_snapshots',
  periodical: 'plan_periodical_snapshots',
};

export const BENEFIT_TABLE_BY_CATEGORY: Record<ProductBenefitCategory, string> = {
  session: 'user_membership_session',
  oneoff: 'user_membership_oneoff',
  periodical: 'user_membership_periodical',
};

/**
 * One snapshotted benefit row, as the API serves it.
 *
 * #924 stage 1 adds `PlanBenefitPrices` — the Original/Agreed and Final Price
 * pair, VAT included, that the Membership Plan and Promotion cards already
 * report (#916, #919/#920), so the Assigned Plan's three sections can render
 * from the one shared column grid instead of their own table. The amounts are
 * the *snapshot's*: the frozen `unit_price` and the frozen `(action, value)`
 * pair, through the same `applyLineBenefit()` the billing engine uses.
 */
export interface AssignedPlanBenefitRow extends PlanBenefitPrices {
  id: number;
  user_membership_id: number;
  product_id: number;
  quantity: number;
  item_name: string;
  item_type: string;
  item_billing_frequency: string | null;
  unit_price: number;
  currency: string | null;
  /**
   * #896 stage 2 — the pricing treatment this line was agreed with, copied
   * from the Plan section at assignment time and frozen here with the price.
   * Read from the snapshot for the same reason the price is: the Plan's own
   * row may have been re-configured since.
   */
  action: ProductBenefit['action'];
  value: number | null;
  /**
   * #918 — a **Session** Benefit's renewal Frequency, as it was agreed. `null`
   * for the other two sections, which have no such column, and for a session
   * row the Plan never configured one on (the dropdown's `—`).
   */
  frequency: SessionBenefitFrequency | null;
  /** #1184 stage 2 — whether the member could decline this benefit when it was assigned. */
  mandatory: boolean;
}

/** The assignment's frozen Billing & Duration, cadence and regular fee. */
export interface AssignedPlanBillingSnapshot {
  free_periods: number | null;
  paid_periods: number | null;
  bonus_periods: number | null;
  /** Stage 13 — of `paid_periods`, how many were already paid up front. */
  pay_beforehand_periods: number | null;
  recurring_billing_interval: number | null;
  recurring_billing_unit: string | null;
  membership_fee_price: number | null;
}

export interface AssignedPlanSnapshot extends AssignedPlanBillingSnapshot {
  session_benefits: AssignedPlanBenefitRow[];
  oneoff_benefits: AssignedPlanBenefitRow[];
  periodical_benefits: AssignedPlanBenefitRow[];
  /**
   * #772 — the assignment's own Personal Membership Fee Benefit.
   *
   * Outside `AssignedPlanBillingSnapshot` on purpose, and not part of
   * `snapshot_captured` below: it is not captured from the catalogue, it has no
   * live counterpart to fall back to, and its columns are NOT NULL with a
   * default — so every assignment carries one, and folding it into the
   * "did this assignment capture anything?" test would answer yes for every
   * row in the table.
   */
  personal_fee_benefit: PersonalFeeBenefit;
  /**
   * #1130 — does this assignment's Billing & Duration cycle start again when it
   * ends? Frozen from the Plan's `billing_policies.auto_renew` at assignment
   * time (migration 230).
   *
   * Outside `AssignedPlanBillingSnapshot` for `personal_fee_benefit`'s reason:
   * the column is NOT NULL with a default, so it has an answer for every row,
   * and `snapshot_captured` below reads that interface's values — folding it in
   * would report every assignment in the table as captured and freeze the
   * duration fallback for rows that captured nothing.
   */
  auto_renew: boolean;
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

const CATEGORIES: ProductBenefitCategory[] = ['session', 'oneoff', 'periodical'];

/**
 * The three snapshot sections' own read.
 *
 * `b.*` is the agreement: every commercial fact of the line was frozen onto it
 * at assignment time (§17). The two joined columns are the one thing the
 * snapshot never captured and never could — the Product's **tax
 * treatment**, which is a statutory rate rather than a term of this contract.
 * #924 §4 asks the card to quote these lines tax-included, so the rate is read
 * live (LEFT JOIN: an item deleted since leaves the frozen amount as the honest
 * gross, exactly as `grossBenefitUnitPrice()` falls back for a gym with no rate
 * configured). The frozen *price* is still the frozen price — nothing here
 * reaches for `products.amount`.
 */
function selectSnapshotSection(table: string): string {
  return `SELECT b.*, gc.tax_behavior AS product_tax_behavior,
                 tr.rate_percent AS product_tax_rate_percent
          FROM ${table} b
          LEFT JOIN products gc ON gc.id = b.product_id AND gc.gym_id = b.gym_id
          LEFT JOIN tax_rates tr ON tr.id = gc.tax_rate_id
          WHERE b.plan_snapshot_id = ${assignmentPlanSnapshotId('?')} AND b.gym_id = ?
          ORDER BY b.item_name ASC, b.id ASC`;
}

function shapeBenefit(row: any): AssignedPlanBenefitRow {
  const unitPrice = row.unit_price != null ? Number(row.unit_price) : 0;
  // A snapshot row came from a Membership Plan section, so it is read with
  // the Plan's option set — the three of §16 and no more.
  const benefit = toProductBenefit('plan', row.action, row.value);
  return {
    id: row.id,
    user_membership_id: row.user_membership_id,
    product_id: row.product_id,
    quantity: Number(row.quantity),
    item_name: row.item_name,
    item_type: row.item_type,
    item_billing_frequency: row.item_billing_frequency ?? null,
    unit_price: unitPrice,
    currency: row.currency ?? null,
    ...benefit,
    // #918 — only `user_membership_session` has the column; the other two read
    // `undefined`, which normalizes to `null`.
    frequency: toSessionBenefitFrequency(row.frequency),
    // #1184 stage 2 — what the assignment was agreed with; `true` for a row
    // written before the column.
    mandatory: toPlanBenefitMandatory(row.mandatory),
    /**
     * #924 stage 1 — what this line costs before and after its own treatment,
     * VAT included, from the one module the Plan and Promotion sections price
     * through. The amount handed over is the **frozen** one, so a Product
     * repriced since cannot move what this member was agreed (§17), and the
     * figures cannot disagree with what the assignment bills: both end at
     * `applyLineBenefit()`.
     */
    ...productBenefitPrices('plan', {
      product_id: row.product_id,
      quantity: row.quantity,
      action: benefit.action,
      value: benefit.value,
      product_amount: row.unit_price,
      product_tax_behavior: row.product_tax_behavior,
      product_tax_rate_percent: row.product_tax_rate_percent,
    }),
  };
}

/** The snapshot of one assignment, for the expanded card and (in stage 3) billing. */
export async function loadAssignedPlanSnapshot(
  gymId: string, umId: number,
): Promise<AssignedPlanSnapshot> {
  const [{ rows: umRows }, ...benefitResults] = await Promise.all([
    db.query(
      `SELECT ${assignmentConfig('free_periods')} AS free_periods, ${assignmentConfig('paid_periods')} AS paid_periods,
              ${assignmentConfig('bonus_periods')} AS bonus_periods,
              ${assignmentConfig('pay_beforehand_periods')} AS pay_beforehand_periods,
              cfg.recurring_billing_interval, cfg.recurring_billing_unit,
              ${assignmentConfig('membership_fee_price')} AS membership_fee_price,
              ${assignmentConfig('personal_fee_benefit_action')} AS personal_fee_benefit_action,
              ${assignmentConfig('personal_fee_benefit_value')} AS personal_fee_benefit_value,
              ${assignmentConfig('auto_renew')} AS auto_renew
       FROM user_memberships um${ASSIGNMENT_CONFIG_JOIN()} WHERE um.id = ? AND um.gym_id = ?`,
      [umId, gymId],
    ),
    ...CATEGORIES.map((category) => db.query(
      selectSnapshotSection(PLAN_SNAPSHOT_TABLE_BY_CATEGORY[category]),
      [umId, gymId],
    )),
  ]);
  const um = umRows[0] ?? {};
  const [session, oneoff, periodical] = benefitResults.map((r) => r.rows.map((row: any) => shapeBenefit({ ...row, user_membership_id: umId })));

  const billing: AssignedPlanBillingSnapshot = {
    free_periods: um.free_periods ?? null,
    paid_periods: um.paid_periods ?? null,
    bonus_periods: um.bonus_periods ?? null,
    pay_beforehand_periods: um.pay_beforehand_periods ?? null,
    recurring_billing_interval: um.recurring_billing_interval ?? null,
    recurring_billing_unit: um.recurring_billing_unit ?? null,
    membership_fee_price: um.membership_fee_price != null ? Number(um.membership_fee_price) : null,
  };

  return {
    ...billing,
    session_benefits: session,
    oneoff_benefits: oneoff,
    periodical_benefits: periodical,
    personal_fee_benefit: toPersonalFeeBenefit(um.personal_fee_benefit_action, um.personal_fee_benefit_value),
    // #1130 — the assignment's own frozen flag, with no live fallback
    // (`ASSIGNMENT_AUTO_RENEW` says why).
    auto_renew: toPlanDurationRepeats(um.auto_renew),
    // Reads `billing` alone — see the note on `personal_fee_benefit` above.
    snapshot_captured:
      Object.values(billing).some((v) => v != null)
      || session.length > 0 || oneoff.length > 0 || periodical.length > 0,
  };
}

/** One section of the snapshot, for the editor's own refetch (#635 stage 6). */
export async function loadAssignedPlanBenefitSection(
  gymId: string, umId: number, category: ProductBenefitCategory,
): Promise<AssignedPlanBenefitRow[]> {
  const { rows } = await db.query(
    selectSnapshotSection(PLAN_SNAPSHOT_TABLE_BY_CATEGORY[category]), [umId, gymId],
  );
  return rows.map((row: any) => shapeBenefit({ ...row, user_membership_id: umId }));
}

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
  // #1325 PR 3e-3: the pair is the version's own (`product_set_plan_snapshots`,
  // frozen from its Plan when the version was created), joined as `cfg` by
  // `ASSIGNMENT_CONFIG_JOIN`; the first argument is kept for the callers that
  // pass it.
  interval: (_um = 'um', bp = 'bp') => `COALESCE(cfg.recurring_billing_interval, ${bp}.recurring_billing_interval)`,
  unit: (_um = 'um', bp = 'bp') => `COALESCE(cfg.recurring_billing_unit, ${bp}.recurring_billing_unit)`,
};

/**
 * #1130 — whether an assignment's Billing & Duration cycle repeats, in SQL.
 *
 * Deliberately **not** a `COALESCE` onto `bp.auto_renew`, which is the shape
 * every other snapshot column here takes and is the one way this goes wrong:
 * `billing_policies.auto_renew` is `NOT NULL DEFAULT true`, so falling back to
 * it would make every assignment written before migration 230 renew — the
 * retroactive billing change the ticket's answer A exists to prevent. The
 * column is NOT NULL with its own backfilled default, so it always has an
 * answer and there is nothing to fall back *to*.
 *
 * It is a function rather than a bare string for the reason the pair above is:
 * three of the five callers alias `user_memberships` as something else.
 */
export const ASSIGNMENT_AUTO_RENEW = (um = 'um') => assignmentConfig('auto_renew', um);

function toFrequency(v: unknown): ProductFrequency | null {
  return (v ?? null) as ProductFrequency | null;
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
 * of the seven snapshot columns set): an assignment that captured a cadence but
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
      SELECT '${category}' AS category, um.id AS user_membership_id, b.product_id, b.quantity,
             b.item_name, b.item_billing_frequency, b.unit_price, b.\`action\`, b.\`value\`,
             ${category === 'session' ? 'b.frequency' : 'NULL'} AS session_frequency
      FROM user_memberships um
      JOIN ${PLAN_SNAPSHOT_TABLE_BY_CATEGORY[category]} b
        ON b.plan_snapshot_id = ${assignmentPlanSnapshotId('um.id', 'um.gym_id')} AND b.gym_id = um.gym_id
      WHERE um.gym_id = ? AND um.id IN (${marks})`).join(' UNION ALL '),
    CATEGORIES.flatMap(() => [gymId, ...ids]),
  );
  for (const row of rows as any[]) {
    const list = byAssignment.get(row.user_membership_id) ?? [];
    list.push({
      productId: row.product_id,
      name: row.item_name,
      category: row.category as ProductBenefitCategory,
      billingFrequency: toFrequency(row.item_billing_frequency),
      unitPrice: row.unit_price != null ? Number(row.unit_price) : 0,
      quantity: positiveQuantity(row.quantity),
      // #918 — the Session Benefit's renewal Frequency, as agreed. What makes
      // the projection report "8 sessions every 4 weeks" rather than 2 once.
      sessionFrequency: toSessionBenefitFrequency(row.session_frequency),
      // #896 stage 3 — the Plan's own treatment of this line, as frozen with
      // it. Read through `toProductBenefit('plan', …)`, so a value stored
      // as mysql2's DECIMAL string arrives as a number and an action a Plan may
      // not configure reads as the neutral default rather than pricing.
      benefit: toProductBenefit('plan', row.action, row.value),
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
      SELECT '${category}' AS category, b.membership_plan_id, b.product_id, b.quantity,
             ${ITEM_NAME_EXPR} AS item_name, gc.billing_frequency, gc.amount,
             b.\`action\`, b.\`value\`,
             ${category === 'session' ? 'b.frequency' : 'NULL'} AS session_frequency
      FROM ${planBenefitTableForCategory(category)} b
      JOIN products gc ON gc.id = b.product_id
      LEFT JOIN charge_types ct ON ct.id = gc.charge_type_id
      WHERE b.gym_id = ? AND b.membership_plan_id IN (${planMarks})`).join(' UNION ALL '),
    CATEGORIES.flatMap(() => [gymId, ...planIds]),
  );
  const livePerPlan = new Map<number, SimulationPlanBenefit[]>();
  for (const row of liveRows as any[]) {
    const list = livePerPlan.get(row.membership_plan_id) ?? [];
    list.push({
      productId: row.product_id,
      name: row.item_name,
      category: row.category as ProductBenefitCategory,
      billingFrequency: toFrequency(row.billing_frequency),
      unitPrice: row.amount != null ? Number(row.amount) : 0,
      quantity: positiveQuantity(row.quantity),
      sessionFrequency: toSessionBenefitFrequency(row.session_frequency),
      benefit: toProductBenefit('plan', row.action, row.value),
    });
    livePerPlan.set(row.membership_plan_id, list);
  }
  for (const a of legacy) {
    const live = livePerPlan.get(a.membershipPlanId as number);
    if (live) byAssignment.set(a.id, live);
  }
  return byAssignment;
}

const PROMOTION_GRANT_SNAPSHOT_TABLE: Record<ProductBenefitCategory, string> = {
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
 * A snapshot row whose `unit_price` is NULL (its Product was already
 * gone when migration 174 backfilled) prices at 0 rather than reaching for a
 * live row that no longer exists.
 */
export async function loadPromotionGrantSnapshots(
  gymId: string, applicationIds: number[],
  /** A transaction, when the applications were written in it and are not yet visible to the pool. */
  exec: { query: Tx['query'] } = db,
): Promise<Map<number, SimulationGrant[]>> {
  const byApplication = new Map<number, SimulationGrant[]>();
  if (applicationIds.length === 0) return byApplication;

  const marks = applicationIds.map(() => '?').join(',');
  const { rows } = await exec.query(
    CATEGORIES.map((category) => `
      SELECT '${category}' AS category, user_membership_promotion_id, product_id,
             product_name, quantity, item_billing_frequency, unit_price,
             \`action\`, \`value\`
      FROM ${PROMOTION_GRANT_SNAPSHOT_TABLE[category]}
      WHERE gym_id = ? AND user_membership_promotion_id IN (${marks})`).join(' UNION ALL '),
    CATEGORIES.flatMap(() => [gymId, ...applicationIds]),
  );
  for (const row of rows as any[]) {
    const list = byApplication.get(row.user_membership_promotion_id) ?? [];
    list.push({
      // The snapshot keeps the item's identity even after it is deleted
      // (`product_id` is ON DELETE SET NULL there); 0 groups those under a
      // line that no longer points at a catalogue row.
      productId: row.product_id ?? 0,
      name: row.product_name ?? 'Product',
      category: row.category as ProductBenefitCategory,
      billingFrequency: toFrequency(row.item_billing_frequency),
      unitPrice: row.unit_price != null ? Number(row.unit_price) : 0,
      quantity: positiveQuantity(row.quantity),
      // #896 stage 3 — what this grant does to the periods/units it covers, as
      // agreed when the Promotion was applied (§16). A row snapshotted before
      // migration 203 carries the `waive` its backfill wrote, which is what a
      // grant meant when the column did not exist.
      benefit: toProductBenefit('promotion', row.action, row.value),
    });
    byApplication.set(row.user_membership_promotion_id, list);
  }
  return byApplication;
}
