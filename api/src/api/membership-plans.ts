import { Router, Request } from 'express';
import { db, Tx } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { handleDupEntry, insertAndFetch } from '../infra/db-helpers';
import { effectivePrice, snapshotFeeForAssignment, LIST_SELECT as MEMBERSHIP_LIST_SELECT, MEMBERS_SELECT as MEMBERSHIP_MEMBERS_SELECT } from './user-memberships';
import { recordStatusChange, sourceForRole } from './billing-events';
import { applyPromotionToMembership } from './membership-promotions';
import { materialiseAssignedPlanSnapshot, snapshotAssignedPlan } from './assigned-plan-snapshot';
import { computePriceFields, validateTaxRateId } from './products';
import { selectPlanTaxRates } from '../domain/planTaxRate';
import { activePlanConflictBody, supersedeStartsAtError } from '../domain/oneActivePlan';
import { findLiveAssignmentsForMembers, supersedeLiveAssignments } from './one-active-plan';
import { computePlanExampleTimeline } from '../domain/planExampleTimeline';
import {
  PlanSimulationItem,
  computePlanBillingEventSimulation,
} from '../domain/planBillingEventSimulation';
import { ProductFrequency } from '../domain/billingSimulation';
import { BillingDateUnit } from '../domain/billingDate';
import { DEFAULT_PLAN_DURATION_CADENCE, toPlanDuration } from '../domain/planDuration';
import {
  describeAcceptedPlanCadences,
  isAcceptedPlanCadence,
} from '../domain/planBillingFrequency';
import {
  classifyProduct,
  planBenefitTableForCategory,
  ProductBenefitCategory,
} from '../domain/productClassification';
import {
  MandatoryProduct,
  PlanBenefitRow,
  PlanBenefitWrite,
  mandatoryItemsForCategory,
  mergeMandatoryBenefits,
  withMandatoryBenefits,
} from '../domain/mandatoryPlanBenefits';
import {
  NO_PRODUCT_BENEFIT,
  ProductBenefit,
  parseProductBenefitInput,
  shapeProductBenefitRow,
  toProductBenefit,
} from '../domain/productBenefitActions';
import {
  SessionBenefitFrequency,
  parseSessionBenefitFrequencyInput,
  toSessionBenefitFrequency,
} from '../domain/sessionBenefitFrequency';
import { PlanBenefitPrices } from '../domain/planBenefitPrices';
import {
  grossBenefitUnitPrice,
  withProductBenefitPrices,
} from './product-benefit-pricing';

interface PlanRow {
  id: number;
  gym_id: string;
  name: string;
  description: string | null;
  lifecycle_status: string;
  enrollment_status: string;
  member_limit: '1' | '2' | 'family';
  tax_rate_id: number | null;
  tax_behavior: 'inclusive' | 'exclusive';
  // #635 §7 — Billing & Duration, the same free/paid/bonus a Promotion carries.
  // Nullable: "never configured" stays distinguishable from an explicit 0.
  free_periods: number | null;
  paid_periods: number | null;
  bonus_periods: number | null;
  // #635 stage 13 — Pre-paid Duration: how many of `paid_periods` are already
  // paid up front (the Promotion's own `pay_beforehand_periods`, migration 189).
  pay_beforehand_periods: number | null;
  created_by: number | null;
  created_by_name?: string | null;
  modified_at: string | null;
  modified_by: number | null;
  modified_by_name?: string | null;
  deleted_at: string | null;
  deleted_by: number | null;
  created_at: string;
}

interface PriceRow {
  id: number;
  membership_plan_id: number;
  gym_id: string;
  price: string;
  valid_from: string;
  valid_to: string | null;
  // #547: 'active' = in force, 'applied' = in force and already pushed onto the
  // plan's Assigned Plans, 'inactive' = superseded (history only).
  status: PriceStatus;
  applied_at: string | null;
  // VAT in force while this price was, so a history row keeps reading correctly
  // after the plan's tax rate changes.
  tax_rate_id: number | null;
  tax_rate_percent: string | null;
}

type PriceStatus = 'active' | 'applied' | 'inactive';

interface BillingPolicyRow {
  id: number;
  gym_id: string;
  membership_plan_id: number;
  // #635 stage 13 (migration 189): the Initial Billing / Initial Service /
  // Recurring Service pairs are gone — nothing billed off them. What is left is
  // the Billing frequency, presented inside the Plan's BILLING & DURATION
  // section, and Auto-renew beside it.
  recurring_billing_interval: number | null;
  recurring_billing_unit: string | null;
  auto_renew: boolean;
}

// #635 stage 1: one row of a Plan's Session / One-off / Period Benefits
// (migration 173). `product_*` comes from the join, so an item that has
// since gone inactive still resolves to its real name and status instead of a
// bare id — same shape the Promotion benefit endpoints return.
interface PlanProductBenefitRow extends PlanBenefitRow {
  id: number;
  gym_id: string;
  membership_plan_id: number;
  product_id: number;
  quantity: number;
  product_name: string;
  product_type: string;
  product_billing_frequency: string | null;
  product_status: string;
  /**
   * #918 — the Session Benefit's renewal Frequency. Present on the session
   * section only (`membership_plan_session`), `null` for a row configured with
   * none; the other two sections never carry the key.
   */
  frequency?: SessionBenefitFrequency | null;
  // #893: joined so the editor can hide Remove on a mandatory item and say why.
  product_mandatory: boolean | number;
  // #896 stage 2: the line's own pricing treatment, normalized by the loader.
  action: string;
  value: number | null;
}

interface ProductRow {
  id: number;
  gym_id: string;
  name: string;
  type: string;
  charge_type_code: string | null;
  charge_type_name: string | null;
  amount: string | null;
  currency: string | null;
  billing_frequency: string | null;
  status: string;
  availability: string | null;
  enrollment_status: string;
  is_system: boolean | number;
  // #893: whether every Membership Plan must carry this item.
  mandatory: boolean | number;
  // #915 — what the item's gross price is computed from (`computePriceFields`).
  tax_behavior?: string | null;
  tax_rate_percent?: string | null;
}

/**
 * #915 — one Plan benefit row, as the Billing Event Simulation reads it. The
 * price columns come either from the row's own join (a stored row) or from the
 * active catalogue (a Mandatory item the Plan has no row for yet), which is why
 * they are optional here.
 */
interface BenefitPricingRow extends PlanBenefitRow {
  product_amount?: string | number | null;
  product_tax_behavior?: string | null;
  product_tax_rate_percent?: string | number | null;
}

/**
 * #916 — the section as the card renders it: every row plus the Original and
 * Final Price it must show, VAT included.
 *
 * Since #920 the wiring is `api/product-benefit-pricing.ts`'s, because the
 * Promotion card's three sections now report the same pair and a second copy of
 * the gross-up is exactly what would let the two screens price one item two
 * ways. This wrapper is only the Plan's `context`.
 */
function withPlanBenefitPrices<T extends PlanBenefitRow>(
  rows: (T | PlanBenefitRow)[], catalogue?: ProductRow[],
): ((T | PlanBenefitRow) & PlanBenefitPrices)[] {
  return withProductBenefitPrices('plan', rows as BenefitPricingRow[], catalogue) as
    ((T | PlanBenefitRow) & PlanBenefitPrices)[];
}

/**
 * The Plan's three Benefit sections as `PlanSimulationItem`s: the quantity and
 * `(action, value)` pair each row configures, and the item's **gross** unit
 * price, which is what makes the whole projection VAT-inclusive (#915, and #817
 * for why the arithmetic is the server's).
 *
 * An item with no tax rate configured contributes its stored amount — exactly
 * how `formatPlanCurrentPrice()` falls back for the Plan's own price, and the
 * only honest answer when there is no tax to include.
 *
 * The category is the section the row is in, never a re-classification: #550's
 * `classifyProduct()` is what put it there, and asking twice is how a row
 * ends up billed as a different kind of benefit than it is stored as.
 */
function planSimulationItems(
  sections: { category: ProductBenefitCategory; rows: (PlanBenefitRow | BenefitPricingRow)[] }[],
  catalogue: ProductRow[],
): PlanSimulationItem[] {
  const byId = new Map(catalogue.map((item) => [Number(item.id), item]));
  const items: PlanSimulationItem[] = [];
  for (const { category, rows } of sections) {
    for (const row of rows as BenefitPricingRow[]) {
      // #916: the same gross-up the Benefit sections' own Original Price uses,
      // so the two projections on one card cannot price an item differently.
      const gross = grossBenefitUnitPrice(row, byId.get(Number(row.product_id)));
      if (gross == null) continue; // an item with no price bills nothing
      items.push({
        productId: Number(row.product_id),
        name: row.product_name,
        category,
        billingFrequency: (row.product_billing_frequency as ProductFrequency | null) ?? null,
        unitPriceInclTax: gross,
        quantity: Number(row.quantity) || 1,
        // #918 — the Session Benefit's own renewal Frequency. The column only
        // exists on the session section, so every other row reads `null` and
        // keeps the single charge it has always had.
        sessionFrequency: category === 'session'
          ? toSessionBenefitFrequency(row.frequency) : null,
        benefit: toProductBenefit('plan', row.action, row.value),
        mandatory: row.product_mandatory === true || Number(row.product_mandatory) === 1,
      });
    }
  }
  return items;
}

export const membershipPlansRouter = Router();

const VALID_MEMBER_LIMIT = ['1', '2', 'family'];
const VALID_TAX_BEHAVIORS = ['inclusive', 'exclusive'];
// The `billing_policies.recurring_billing_unit` ENUM (migration 060) — the one
// cadence a Plan still carries after stage 13 (migration 189). #820 narrows
// which *pairs* of it a Plan may be configured with (see
// `domain/planBillingFrequency.ts`); the ENUM itself is unchanged, because an
// assignment's frozen snapshot and every row written before the rule still use
// it.
const BILLING_UNITS = ['day', 'week', 'month', 'year'];

// #635 §7: Billing & Duration, with the Promotion's semantics (migration 102).
// Whole numbers, never negative — and since #892 (migration 201) counts of the
// Plan's own **Billing Frequency periods**, not of calendar months: "2" on a
// 4-weekly Plan is 2 × 4 weeks. Sent together by the section's own Save, and an
// empty field clears the value back to "not configured" rather than writing 0.
const DURATION_FIELDS = ['free_periods', 'paid_periods', 'bonus_periods', 'pay_beforehand_periods'] as const;

/** null = absent (leave as is), or a parsed non-negative integer. Throws the error string for a bad value. */
function parseDurationPeriods(raw: unknown, field: string): number | null | string {
  if (raw === undefined) return null;
  if (raw === null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  if (!Number.isInteger(n) || n < 0) return `${field} must be a non-negative integer`;
  return n;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getCallerMembershipId(req: Request): Promise<number | null> {
  const userId = req.auth?.userId;
  if (!userId) return null;
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    'SELECT id FROM gym_memberships WHERE gym_id = ? AND user_id = ? LIMIT 1',
    [gymId, userId],
  );
  return rows.length > 0 ? rows[0].id : null;
}

async function enrichPlan(plan: PlanRow, gymId: string): Promise<object> {
  const [prices, bpRows, centers, memberCount, products, taxRateRows, promotionCount,
         sessionBenefits, oneoffBenefits, periodicalBenefits] = await Promise.all([
    db.query<PriceRow>(
      'SELECT * FROM membership_plan_prices WHERE membership_plan_id = ? AND gym_id = ? ORDER BY valid_from ASC',
      [plan.id, gymId],
    ).then(r => r.rows),
    db.query<BillingPolicyRow>(
      'SELECT * FROM billing_policies WHERE membership_plan_id = ? AND gym_id = ?',
      [plan.id, gymId],
    ).then(r => r.rows),
    db.query(
      `SELECT mpc.center_id AS id, c.name
       FROM membership_plan_centers mpc
       JOIN centers c ON c.id = mpc.center_id
       WHERE mpc.membership_plan_id = ? AND mpc.gym_id = ?`,
      [plan.id, gymId],
    ).then(r => r.rows),
    db.query(
      `SELECT COUNT(*) AS n FROM user_memberships
       WHERE membership_plan_id = ? AND gym_id = ? AND status = 'active'`,
      [plan.id, gymId],
    ).then(r => Number(r.rows[0].n)),
    // Full catalog of active products for this gym, so the admin UI can
    // populate the Benefit selectors without a separate round trip.
    // #915 also reads `tax_behavior` + the joined rate from here: a Mandatory
    // item this Plan has no stored benefit row for yet (#893's `implicit: true`)
    // has no row to carry its price, so the Billing Event Simulation grosses it
    // up from the catalogue entry. Every implicit item is by definition active
    // and non-deleted, which is exactly what this query already selects.
    db.query<ProductRow>(
      `SELECT gc.id, gc.gym_id, gc.name, gc.type, gc.amount, gc.currency, gc.billing_frequency,
              gc.status, gc.availability, gc.enrollment_status, gc.is_system, gc.mandatory,
              gc.tax_behavior, tr.rate_percent AS tax_rate_percent,
              ct.code AS charge_type_code, ct.name AS charge_type_name
       FROM products gc
       LEFT JOIN charge_types ct ON ct.id = gc.charge_type_id
       LEFT JOIN tax_rates tr ON tr.id = gc.tax_rate_id
       WHERE gc.gym_id = ? AND gc.deleted_at IS NULL AND gc.status = 'active'
       ORDER BY gc.is_system DESC, gc.name ASC`,
      [gymId],
    ).then(r => r.rows),
    // #413 serves the Plan's own Tax rate; #817 also needs the rate the money is
    // actually computed at, which for a Plan that never picked one ("Default" in
    // the Pricing editor) is the gym's system rate — the same row the editor's
    // own live preview resolves to, and the same one `seedSystemPtPackage()`
    // picks. One query for both, so the list endpoint's per-plan round trips do
    // not grow: the Plan's explicit rate is what the card *displays*, the system
    // rate is the fallback the net/gross split is *derived* from.
    db.query<{ id: number; name: string; rate_percent: string; is_system: number; deleted_at: Date | null }>(
      `SELECT id, name, rate_percent, is_system, deleted_at
         FROM tax_rates
        WHERE gym_id = ? AND (id = ? OR (is_system = 1 AND deleted_at IS NULL))
        ORDER BY is_system DESC, id ASC`,
      [gymId, plan.tax_rate_id],
    ).then(r => r.rows),
    // #512: promotion count for the Membership Plan Details modal's compact summary.
    db.query(
      `SELECT COUNT(*) AS n
       FROM promotion_membership_plans pmp
       JOIN promotions p ON p.id = pmp.promotion_id
       WHERE pmp.membership_plan_id = ? AND pmp.gym_id = ? AND p.deleted_at IS NULL`,
      [plan.id, gymId],
    ).then(r => Number(r.rows[0].n)),
    // #635 stage 1: the three Product-keyed Benefit sections (migration
    // 173), served with the plan so the Plans page renders them without three
    // extra round trips per card — same reason `products` is inlined above.
    ...(['session', 'oneoff', 'periodical'] as ProductBenefitCategory[]).map(category =>
      loadPlanBenefits(planBenefitTableForCategory(category), plan.id, gymId),
    ),
  ]);

  const today = new Date().toISOString().slice(0, 10);
  // mysql2 may return DATE columns as Date objects (not strings) depending on the
  // connection's timezone config — normalize before string-comparing.
  const toDateStr = (v: unknown): string | null =>
    v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
  // #547: a price replaced earlier the same day keeps a same-day closed window,
  // so more than one row can cover today — the one that is not history wins,
  // then the most recent. Mirrors CURRENT_PRICE_SQL's ordering.
  const currentPrice = prices
    .filter(p => {
      const from = toDateStr(p.valid_from);
      const to = toDateStr(p.valid_to);
      return from != null && from <= today && (to == null || to >= today);
    })
    .sort((a, b) => {
      const historyRank = Number(a.status === 'inactive') - Number(b.status === 'inactive');
      if (historyRank !== 0) return historyRank;
      const from = String(toDateStr(b.valid_from)).localeCompare(String(toDateStr(a.valid_from)));
      return from !== 0 ? from : b.id - a.id;
    })[0] ?? null;

  // #817: `taxRate` is what the card *displays* (`null` ⇒ "Default", unchanged
  // since #413); `effectiveTaxRate` is what the net/gross split is *derived*
  // from, which for a Plan on "Default" is the gym's system rate. The rule is
  // `domain/planTaxRate.ts` — `applied_tax_rate` reports which one was used.
  const { own: taxRate, effective: effectiveTaxRate } =
    selectPlanTaxRates(taxRateRows, plan.tax_rate_id);
  const priceFields = computePriceFields({
    amount: currentPrice ? currentPrice.price : null,
    tax_rate_percent: effectiveTaxRate ? effectiveTaxRate.rate_percent : null,
    tax_behavior: plan.tax_behavior,
  });

  const billingPolicy = bpRows[0] ?? null;
  // The Plan's stored cadence, resolved once: #818's Example timeline and #915's
  // Billing Event Simulation must step by the same pair, and re-deriving it per
  // projection is how two previews of one Plan come to disagree.
  const planCadence = billingPolicy
    ? {
        interval: Number(billingPolicy.recurring_billing_interval),
        unit: billingPolicy.recurring_billing_unit as BillingDateUnit,
      }
    : null;
  // #892 — the durations are counts of this Plan's own Billing Frequency
  // periods; each projection re-binds them to the cadence it steps by, so the
  // rows and their statuses can never be stepped differently.
  const exampleTimelineDuration = toPlanDuration(
    plan.free_periods, plan.paid_periods, plan.bonus_periods, plan.pay_beforehand_periods,
    planCadence ?? DEFAULT_PLAN_DURATION_CADENCE,
  );
  // #818: the Example timeline replaces #485's Billing Events Forecast. One row
  // per billing period of the Plan's own cadence, each classified by the Plan's
  // Billing & Duration through `classifyPlanDurationPeriod()` — the same rule
  // the nightly run prices a cycle with, so the table can never advertise a
  // charge the run does not make. The price it quotes is the VAT-inclusive one
  // the Pricing section shows (`amount_incl_tax`, or the gross alone for a gym
  // with no tax rate at all, exactly as `formatPlanCurrentPrice()` falls back);
  // no tax arithmetic happens in the projection or in the frontend (#817).
  const exampleTimeline = computePlanExampleTimeline({
    duration: exampleTimelineDuration,
    cadence: planCadence,
    priceInclTax: priceFields.amount_incl_tax
      ?? (currentPrice ? parseFloat(currentPrice.price) : null),
  });

  // #547: the stored status is a projection of the validity windows, refreshed on
  // every price write — but nothing rewrites it when a window simply expires with
  // the calendar. Derive what the history displays from the dates, so a plan
  // nobody has saved since its price window ended never shows a stale badge.
  const priceHistory = prices.map(p => ({
    ...p,
    status: currentPrice && p.id === currentPrice.id
      ? (p.applied_at != null ? 'applied' : 'active')
      : 'inactive',
  }));

  // #893: a Mandatory Product is part of every Plan, so each section is
  // the stored rows plus the mandatory items this Plan has no row for yet.
  // `products` above is already the gym's active, non-deleted catalogue —
  // exactly the candidate set the rule takes — so no extra round trip.
  // #916: and each row carries the Original / Final Price the card shows — one
  // pricing pass over the merged section, so a Mandatory item the Plan has no
  // stored row for yet is quoted exactly like a configured one.
  const sessionSection = withPlanBenefitPrices(
    mergeMandatoryBenefits(sessionBenefits, mandatoryItemsForCategory(products, 'session')), products);
  const oneoffSection = withPlanBenefitPrices(
    mergeMandatoryBenefits(oneoffBenefits, mandatoryItemsForCategory(products, 'oneoff')), products);
  const periodicalSection = withPlanBenefitPrices(
    mergeMandatoryBenefits(periodicalBenefits, mandatoryItemsForCategory(products, 'periodical')), products);

  // #915: the Billing Event Simulation — the same three sections the card
  // renders, projected into the billing events a member enrolling today would
  // be charged, grouped by date. A projection over the Billing Simulation
  // engine, so it cannot price a cycle differently from the nightly run; the
  // durations, the cadence and the price are the ones the Example Timeline
  // above already read.
  const billingEventSimulation = computePlanBillingEventSimulation({
    planName: plan.name,
    duration: exampleTimelineDuration,
    cadence: planCadence,
    membershipFeeInclTax: priceFields.amount_incl_tax
      ?? (currentPrice ? parseFloat(currentPrice.price) : null),
    items: planSimulationItems([
      { category: 'oneoff', rows: oneoffSection },
      { category: 'session', rows: sessionSection },
      { category: 'periodical', rows: periodicalSection },
    ], products),
  });

  return {
    ...plan,
    current_price: currentPrice ? currentPrice.price : null,
    price_history: priceHistory,
    billing_policy: billingPolicy,
    centers,
    member_count: memberCount,
    promotion_count: promotionCount,
    session_benefits: sessionSection,
    oneoff_benefits: oneoffSection,
    periodical_benefits: periodicalSection,
    products: products,
    tax_rate_name: taxRate ? taxRate.name : null,
    tax_rate_percent: taxRate ? taxRate.rate_percent : null,
    ...priceFields,
    // #485/#818: read-only, dynamically computed — never persisted (see docs/architecture.md).
    example_timeline: exampleTimeline,
    // #915: the same — computed on every read, persisted nowhere, charges nothing.
    billing_event_simulation: billingEventSimulation,
  };
}

async function planExists(planId: string | string[], gymId: string): Promise<boolean> {
  const { rows } = await db.query(
    'SELECT 1 FROM membership_plans WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [planId, gymId],
  );
  return rows.length > 0;
}

// ─── Plan CRUD ────────────────────────────────────────────────────────────────

membershipPlansRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const status = req.query.lifecycle_status as string | undefined;
  // #634 §2: the Member page's plan picker offers only Active + Public plans,
  // so it asks for `lifecycle_status=active&enrollment_status=public`. The rule
  // itself is enforced on assignment (planAssignabilityError in
  // user-memberships.ts) — this filter only keeps the picker from offering what
  // the API would refuse.
  const enrollment = req.query.enrollment_status as string | undefined;
  let sql = `SELECT mp.*,
                    gm_c.name AS created_by_name,
                    gm_m.name AS modified_by_name
             FROM membership_plans mp
             LEFT JOIN gym_memberships gm_c ON gm_c.id = mp.created_by
             LEFT JOIN gym_memberships gm_m ON gm_m.id = mp.modified_by
             WHERE mp.gym_id = ? AND mp.deleted_at IS NULL`;
  const params: (string | number)[] = [gymId];
  if (status) { sql += ' AND mp.lifecycle_status = ?'; params.push(status); }
  if (enrollment) { sql += ' AND mp.enrollment_status = ?'; params.push(enrollment); }
  sql += ' ORDER BY mp.name ASC';
  const { rows } = await db.query<PlanRow>(sql, params);
  const enriched = await Promise.all(rows.map(p => enrichPlan(p, gymId)));
  res.json(enriched);
});

membershipPlansRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query<PlanRow>(
    `SELECT mp.*,
            gm_c.name AS created_by_name,
            gm_m.name AS modified_by_name
     FROM membership_plans mp
     LEFT JOIN gym_memberships gm_c ON gm_c.id = mp.created_by
     LEFT JOIN gym_memberships gm_m ON gm_m.id = mp.modified_by
     WHERE mp.id = ? AND mp.gym_id = ? AND mp.deleted_at IS NULL`,
    [req.params.id, gymId],
  );
  if (!rows[0]) return res.status(404).json({ error: 'Plan not found' });
  res.json(await enrichPlan(rows[0], gymId));
});

async function getSystemTaxRateId(gymId: string): Promise<number | null> {
  const { rows } = await db.query(
    'SELECT id FROM tax_rates WHERE gym_id = ? AND is_system = 1 AND deleted_at IS NULL LIMIT 1',
    [gymId],
  );
  return rows.length > 0 ? rows[0].id : null;
}

membershipPlansRouter.post('/', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { name, description, lifecycle_status, enrollment_status, member_limit, tax_rate_id, tax_behavior } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  if (member_limit !== undefined && !VALID_MEMBER_LIMIT.includes(member_limit)) {
    return res.status(400).json({ error: 'member_limit must be one of: 1, 2, family' });
  }
  if (tax_behavior !== undefined && !VALID_TAX_BEHAVIORS.includes(tax_behavior)) {
    return res.status(400).json({ error: `tax_behavior must be one of: ${VALID_TAX_BEHAVIORS.join(', ')}` });
  }
  const taxRateErr = await validateTaxRateId(gymId, tax_rate_id);
  if (taxRateErr) return res.status(400).json({ error: taxRateErr });
  const resolvedTaxRateId = tax_rate_id != null ? Number(tax_rate_id) : await getSystemTaxRateId(gymId);

  const callerMemberId = await getCallerMembershipId(req);
  try {
    const row = await insertAndFetch(
      `INSERT INTO membership_plans
       (gym_id, name, description, lifecycle_status, enrollment_status, member_limit, tax_rate_id, tax_behavior, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [gymId, name.trim(), description ?? null,
       lifecycle_status ?? 'draft', enrollment_status ?? 'staff_only', member_limit ?? '1',
       resolvedTaxRateId, tax_behavior || 'inclusive', callerMemberId],
      'SELECT * FROM membership_plans WHERE id = ?',
      (id) => [id],
    );
    recordAudit(req, { action: 'create', entityType: 'membership_plan', entityId: row.id, next: row });
    res.status(201).json(await enrichPlan(row, gymId));
  } catch (err: any) {
    handleDupEntry(err, res, next, 'A plan with this name already exists.');
  }
});

membershipPlansRouter.put('/:id', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { name, description, lifecycle_status, enrollment_status, member_limit, tax_rate_id, tax_behavior } = req.body;

  const VALID_LIFECYCLE = ['draft', 'active', 'paused', 'inactive'];
  const VALID_ENROLLMENT = ['public', 'staff_only'];
  if (lifecycle_status && !VALID_LIFECYCLE.includes(lifecycle_status)) {
    return res.status(400).json({ error: 'Invalid lifecycle_status' });
  }
  if (enrollment_status && !VALID_ENROLLMENT.includes(enrollment_status)) {
    return res.status(400).json({ error: 'Invalid enrollment_status' });
  }
  if (tax_behavior !== undefined && !VALID_TAX_BEHAVIORS.includes(tax_behavior)) {
    return res.status(400).json({ error: `tax_behavior must be one of: ${VALID_TAX_BEHAVIORS.join(', ')}` });
  }
  const taxRateErr = await validateTaxRateId(gymId, tax_rate_id);
  if (taxRateErr) return res.status(400).json({ error: taxRateErr });
  if (['public', 'staff_only'].includes(enrollment_status) && lifecycle_status && lifecycle_status !== 'active') {
    return res.status(400).json({ error: 'enrollment can only be public or staff_only when lifecycle_status is active' });
  }
  if (member_limit !== undefined && !VALID_MEMBER_LIMIT.includes(member_limit)) {
    return res.status(400).json({ error: 'member_limit must be one of: 1, 2, family' });
  }
  // #635 §7: Billing & Duration. Each field is independently optional — the
  // section's Save sends all three, but a caller touching only `name` must not
  // have the plan's duration wiped, hence the "field present in body" gate below.
  const durations: Record<string, number | null> = {};
  for (const field of DURATION_FIELDS) {
    const parsed = parseDurationPeriods(req.body[field], field);
    if (typeof parsed === 'string') return res.status(400).json({ error: parsed });
    durations[field] = parsed;
  }
  // #635 stage 13: the Pre-paid Duration is a slice of the Paid Duration, the
  // Promotion's own 0..paid bound (`validatePayBeforehandMonths`), counted in
  // this Plan's Billing Frequency periods since #892.
  // Checked against the plan as it will stand, because either field can be sent
  // on its own and either one alone can break the bound.
  if ('pay_beforehand_periods' in req.body || 'paid_periods' in req.body) {
    const { rows: current } = await db.query(
      `SELECT paid_periods, pay_beforehand_periods FROM membership_plans
       WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
      [req.params.id, gymId],
    );
    if (!current[0]) return res.status(404).json({ error: 'Plan not found' });
    const nextPaid = 'paid_periods' in req.body ? durations.paid_periods : current[0].paid_periods;
    const nextPrepaid = 'pay_beforehand_periods' in req.body
      ? durations.pay_beforehand_periods : current[0].pay_beforehand_periods;
    if (nextPrepaid != null && Number(nextPrepaid) > Number(nextPaid ?? 0)) {
      return res.status(400).json({ error: 'pay_beforehand_periods cannot exceed paid_periods' });
    }
  }
  // Shrinking the cap must not orphan Members already covered by an active
  // Membership on this plan (#374 — the limit is enforced server-side).
  if (member_limit && member_limit !== 'family') {
    const cap = parseInt(member_limit, 10);
    const { rows: over } = await db.query(
      `SELECT COUNT(*) AS n FROM (
         SELECT umm.user_membership_id
         FROM user_membership_members umm
         JOIN user_memberships um ON um.id = umm.user_membership_id AND um.status = 'active'
         WHERE um.membership_plan_id = ? AND um.gym_id = ?
         GROUP BY umm.user_membership_id
         HAVING COUNT(*) > ?
       ) over_limit`,
      [req.params.id, gymId, cap],
    );
    if (Number(over[0].n) > 0) {
      return res.status(400).json({ error: 'Cannot reduce the member limit below the covered Members of an existing active Membership.' });
    }
  }

  const callerMemberId = await getCallerMembershipId(req);
  try {
    const { rowCount } = await db.query(
      `UPDATE membership_plans SET
        name              = COALESCE(?, name),
        description       = IF(?, ?, description),
        lifecycle_status  = COALESCE(?, lifecycle_status),
        enrollment_status = COALESCE(?, enrollment_status),
        member_limit      = COALESCE(?, member_limit),
        tax_rate_id       = COALESCE(?, tax_rate_id),
        tax_behavior      = COALESCE(?, tax_behavior),
        free_periods       = IF(?, ?, free_periods),
        paid_periods       = IF(?, ?, paid_periods),
        bonus_periods      = IF(?, ?, bonus_periods),
        pay_beforehand_periods = IF(?, ?, pay_beforehand_periods),
        modified_at       = NOW(),
        modified_by       = ?
       WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
      [
        name?.trim() ?? null,
        'description' in req.body ? 1 : 0, description ?? null,
        lifecycle_status ?? null,
        enrollment_status ?? null,
        member_limit ?? null,
        tax_rate_id != null ? Number(tax_rate_id) : null,
        tax_behavior ?? null,
        // COALESCE can't express "clear this back to NULL", which Billing &
        // Duration needs — an emptied field means "not configured", not 0. The
        // IF(present, value, current) pair writes only the fields actually sent.
        'free_periods' in req.body ? 1 : 0, durations.free_periods,
        'paid_periods' in req.body ? 1 : 0, durations.paid_periods,
        'bonus_periods' in req.body ? 1 : 0, durations.bonus_periods,
        'pay_beforehand_periods' in req.body ? 1 : 0, durations.pay_beforehand_periods,
        callerMemberId,
        req.params.id, gymId,
      ],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Plan not found' });
    const { rows } = await db.query('SELECT * FROM membership_plans WHERE id = ?', [req.params.id]);
    recordAudit(req, { action: 'update', entityType: 'membership_plan', entityId: req.params.id, next: rows[0] });
    res.json(await enrichPlan(rows[0], gymId));
  } catch (err: any) {
    handleDupEntry(err, res, next, 'A plan with this name already exists.');
  }
});

membershipPlansRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  const { gymId, actorName } = getTenantContext(req);
  const { rows: active } = await db.query(
    `SELECT COUNT(*) AS n FROM user_memberships
     WHERE membership_plan_id = ? AND gym_id = ? AND status = 'active'`,
    [req.params.id, gymId],
  );
  if (Number(active[0].n) > 0) {
    return res.status(400).json({ error: 'Cannot delete a plan with active memberships.' });
  }
  const callerMemberId = await getCallerMembershipId(req);
  const { rowCount } = await db.query(
    `UPDATE membership_plans SET deleted_at = NOW(), deleted_by = ?, deleted_by_name = ?, enrollment_status = 'staff_only'
     WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
    [callerMemberId, actorName, req.params.id, gymId],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Plan not found' });
  recordAudit(req, { action: 'delete', entityType: 'membership_plan', entityId: req.params.id });
  res.status(204).send();
});

// ─── Assign to Member(s) (#376) ────────────────────────────────────────────────
// Instantiates the Plan into a new Membership for one or more existing
// Members, snapshotting the Plan's current charge benefits onto the
// Membership (so later Plan edits never retroactively change it), applying
// any Promotions currently targeting the Plan, and emitting the same
// creation billing event as POST /user-memberships (P1.6 ledger).

membershipPlansRouter.post('/:id/assign', requireRole('admin'), async (req, res, next) => {
  const { gymId, userId, role } = getTenantContext(req);
  const { member_ids, owner_member_id, starts_at } = req.body;

  const { rows: planRows } = await db.query(
    // `name` is only wording — it is what #956's replacement warning calls the
    // Plan being assigned.
    'SELECT id, name, member_limit FROM membership_plans WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [req.params.id, gymId],
  );
  if (planRows.length === 0) return res.status(404).json({ error: 'Plan not found' });
  const plan = planRows[0];

  if (!Array.isArray(member_ids) || member_ids.length === 0) {
    return res.status(400).json({ error: 'member_ids must be a non-empty array' });
  }
  if (!starts_at) return res.status(400).json({ error: 'starts_at is required' });
  const uniqueMemberIds = [...new Set(member_ids.map((id: any) => Number(id)))];
  const ownerId = Number(owner_member_id);
  if (!owner_member_id || !uniqueMemberIds.includes(ownerId)) {
    return res.status(400).json({ error: 'owner_member_id must be one of the selected member_ids' });
  }
  if (plan.member_limit !== 'family' && uniqueMemberIds.length !== parseInt(plan.member_limit, 10)) {
    return res.status(400).json({ error: `This plan requires exactly ${plan.member_limit} member(s).` });
  }

  const placeholders = uniqueMemberIds.map(() => '?').join(',');
  const { rows: memberRows } = await db.query(
    `SELECT id FROM members WHERE gym_id = ? AND deleted_at IS NULL AND id IN (${placeholders})`,
    [gymId, ...uniqueMemberIds],
  );
  if (memberRows.length !== uniqueMemberIds.length) {
    return res.status(400).json({ error: 'One or more selected members were not found.' });
  }

  const eff = await effectivePrice(Number(req.params.id), gymId, starts_at);
  if (!eff) return res.status(404).json({ error: 'Plan not found' });

  // #956: one Member, one Membership Plan — and this route assigns a set of
  // them at once, so *every* selected member's live plan is found and locked in
  // the same transaction as the insert, and `confirm: true` cancels all of them
  // together. An all-or-nothing answer is the point: a family assignment that
  // replaced three members' plans and refused the fourth would leave the gym
  // with three cancellations it did not get to weigh.
  const confirm = req.body?.confirm === true;

  try {
    const outcome = await db.transaction(async (tx) => {
      const conflicts = await findLiveAssignmentsForMembers(tx, gymId, uniqueMemberIds);
      if (conflicts.length > 0) {
        if (!confirm) return { kind: 'conflict' as const, conflicts };
        const dateError = supersedeStartsAtError(String(starts_at), conflicts);
        if (dateError) return { kind: 'bad_date' as const, message: dateError };
        await supersedeLiveAssignments(tx, {
          gymId, conflicts, newStartsAt: String(starts_at),
          source: sourceForRole(role), actorUserId: userId,
        });
      }
      const { insertId } = await tx.query(
        `INSERT INTO user_memberships
         (member_id, gym_id, membership_plan_id, base_price, plan_price_id, starts_at, status)
         VALUES (?, ?, ?, ?, ?, ?, 'active')`,
        [ownerId, gymId, req.params.id, eff.base_price, eff.plan_price_id, starts_at],
      );
      await recordStatusChange(tx, {
        gymId, userMembershipId: insertId, memberId: ownerId,
        previousStatus: null, newStatus: 'active',
        source: sourceForRole(role), actorUserId: userId,
      });
      for (const memberId of uniqueMemberIds) {
        await tx.query(
          'INSERT INTO user_membership_members (gym_id, user_membership_id, member_id, is_owner) VALUES (?, ?, ?, ?)',
          [gymId, insertId, memberId, memberId === ownerId ? 1 : 0],
        );
      }
      // #635 stage 2 — the commercial configuration (Billing & Duration,
      // cadence, regular fee, and the three benefit sections) is frozen onto
      // the assignment here, so every assignment entry point captures the same
      // set. Stage 4 removed the separate #376 charge-benefit snapshot this
      // used to sit next to: Charge Benefits no longer exist.
      await snapshotAssignedPlan(tx, {
        gymId, userMembershipId: insertId,
        membershipPlanId: Number(req.params.id),
        membershipFeePrice: eff.plan_price_id != null ? eff.price : null,
      });
      return { kind: 'created' as const, insertId, superseded: conflicts.map((c) => c.id) };
    });
    if (outcome.kind === 'bad_date') return res.status(400).json({ error: outcome.message });
    if (outcome.kind === 'conflict') {
      return res.status(409).json(activePlanConflictBody(outcome.conflicts, plan.name ?? null));
    }
    const insertId = outcome.insertId;

    // Auto-apply any Promotion currently targeting this Plan (#376 item 7/8) — best
    // effort per promotion: a non-stackable conflict must not fail the assignment.
    const { rows: promoRows } = await db.query(
      `SELECT p.id FROM promotions p
       JOIN promotion_membership_plans pmp ON pmp.promotion_id = p.id
       WHERE pmp.membership_plan_id = ? AND p.gym_id = ? AND p.lifecycle_status = 'active'
         AND p.starts_at <= UTC_TIMESTAMP() AND p.ends_at >= UTC_TIMESTAMP()`,
      [req.params.id, gymId],
    );
    for (const promo of promoRows) {
      try {
        await applyPromotionToMembership(gymId, userId, sourceForRole(role), insertId, promo.id);
      } catch {
        // Not stackable with one already applied, or otherwise inapplicable — skip it.
      }
    }

    const { rows } = await db.query(`${MEMBERSHIP_LIST_SELECT} WHERE um.id = ?`, [insertId]);
    const { rows: coveredMembers } = await db.query(MEMBERSHIP_MEMBERS_SELECT, [insertId, gymId]);
    recordAudit(req, {
      action: 'assign_plan', entityType: 'user_membership', entityId: insertId, next: rows[0],
      previous: outcome.superseded.length > 0
        ? { superseded_user_membership_ids: outcome.superseded } : undefined,
    });
    res.status(201).json({ ...rows[0], members: coveredMembers });
  } catch (err: any) {
    // #956 (migration 213): a Member holds at most one live Membership Plan, so
    // a duplicate key here means a second active row for the owning Member was
    // inserted concurrently — the check above found nothing to lock and the
    // restored UNIQUE index is what serialises that case.
    handleDupEntry(err, res, next, 'One of the selected members already has an active Membership Plan.');
  }
});

// ─── Duplicate ────────────────────────────────────────────────────────────────

membershipPlansRouter.post('/:id/duplicate', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { rows: origRows } = await db.query(
    'SELECT * FROM membership_plans WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [req.params.id, gymId],
  );
  if (origRows.length === 0) return res.status(404).json({ error: 'Plan not found' });
  const orig = origRows[0];
  const callerMemberId = await getCallerMembershipId(req);

  try {
    const newPlanId = await db.transaction(async (tx) => {
      const { insertId } = await tx.query(
        `INSERT INTO membership_plans
         (gym_id, name, description, lifecycle_status, enrollment_status, member_limit, tax_rate_id, tax_behavior,
          free_periods, paid_periods, bonus_periods, pay_beforehand_periods, created_by)
         VALUES (?, ?, ?, 'draft', 'staff_only', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [gymId, `${orig.name} (Copy)`, orig.description ?? null, orig.member_limit, orig.tax_rate_id, orig.tax_behavior,
         // #635: Billing & Duration is part of the plan's commercial config, so
         // a copy that dropped it would quietly differ from its original.
         orig.free_periods ?? null, orig.paid_periods ?? null, orig.bonus_periods ?? null,
         orig.pay_beforehand_periods ?? null, callerMemberId],
      );

      // Copy billing policy
      const { rows: bp } = await tx.query(
        'SELECT * FROM billing_policies WHERE membership_plan_id = ? AND gym_id = ?',
        [req.params.id, gymId],
      );
      if (bp.length > 0) {
        const b = bp[0];
        await tx.query(
          `INSERT INTO billing_policies
           (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit, auto_renew)
           VALUES (?, ?, ?, ?, ?)`,
          [gymId, insertId, b.recurring_billing_interval, b.recurring_billing_unit, b.auto_renew],
        );
      }

      // Copy prices
      const { rows: prices } = await tx.query(
        'SELECT * FROM membership_plan_prices WHERE membership_plan_id = ? AND gym_id = ?',
        [req.params.id, gymId],
      );
      for (const p of prices) {
        // #547: the copy carries the VAT snapshot and the price's place in the
        // history, but never the "applied to assigned plans" marker — the new
        // plan has no Assigned Plans yet.
        await tx.query(
          `INSERT INTO membership_plan_prices
             (gym_id, membership_plan_id, price, valid_from, valid_to, status, tax_rate_id, tax_rate_percent)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [gymId, insertId, p.price, p.valid_from, p.valid_to,
           p.status === 'inactive' ? 'inactive' : 'active', p.tax_rate_id ?? null, p.tax_rate_percent ?? null],
        );
      }

      // #635 stage 4: Included Services (`plan_allowances`) is retired, so there
      // are no allowances to copy. Which activities the copy may be used for is
      // the Activity Type's own `activity_type_eligible_plans` list, which names
      // the original plan — a copy is a new plan and starts off named by none.

      // Copy centers
      const { rows: centers } = await tx.query(
        'SELECT * FROM membership_plan_centers WHERE membership_plan_id = ? AND gym_id = ?',
        [req.params.id, gymId],
      );
      for (const c of centers) {
        await tx.query(
          'INSERT INTO membership_plan_centers (gym_id, membership_plan_id, center_id) VALUES (?, ?, ?)',
          [gymId, insertId, c.center_id],
        );
      }

      // #635 stage 1: Session / One-off / Period Benefits. `created_by_membership_id`
      // records who made the copy, not who configured the original.
      for (const category of ['session', 'oneoff', 'periodical'] as ProductBenefitCategory[]) {
        const table = planBenefitTableForCategory(category);
        // #896 stage 2: the `(action, value)` pricing treatment travels with the
        // quantity — Duplicate is a copy, not a re-configuration. #918: so does
        // a Session Benefit's renewal Frequency, for the same reason — a copy of
        // a Plan granting 2 sessions a week must not read as a one-time 2.
        const sessionFrequency = category === 'session';
        const { rows: benefits } = await tx.query(
          `SELECT product_id, quantity, \`action\`, \`value\`${sessionFrequency ? ', frequency' : ''}
             FROM ${table}
            WHERE membership_plan_id = ? AND gym_id = ?`,
          [req.params.id, gymId],
        );
        for (const b of benefits) {
          await tx.query(
            `INSERT INTO ${table}
               (gym_id, membership_plan_id, product_id, quantity, \`action\`, \`value\`,
                created_by_membership_id${sessionFrequency ? ', frequency' : ''})
             VALUES (?, ?, ?, ?, ?, ?, ?${sessionFrequency ? ', ?' : ''})`,
            [
              gymId, insertId, b.product_id, b.quantity, b.action, b.value, callerMemberId,
              ...(sessionFrequency ? [b.frequency ?? null] : []),
            ],
          );
        }
      }

      return insertId;
    });

    const { rows } = await db.query('SELECT * FROM membership_plans WHERE id = ?', [newPlanId]);
    res.status(201).json(await enrichPlan(rows[0], gymId));
  } catch (err) {
    next(err);
  }
});

// ─── Archive ──────────────────────────────────────────────────────────────────

membershipPlansRouter.post('/:id/archive', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows: active } = await db.query(
    `SELECT COUNT(*) AS n FROM user_memberships
     WHERE membership_plan_id = ? AND gym_id = ? AND status = 'active'`,
    [req.params.id, gymId],
  );
  if (Number(active[0].n) > 0) {
    return res.status(400).json({ error: 'Cannot deactivate a plan with active memberships.' });
  }
  const callerMemberId = await getCallerMembershipId(req);
  const { rowCount } = await db.query(
    `UPDATE membership_plans
     SET lifecycle_status = 'inactive', enrollment_status = 'staff_only', modified_at = NOW(), modified_by = ?
     WHERE id = ? AND gym_id = ? AND lifecycle_status = 'active' AND deleted_at IS NULL`,
    [callerMemberId, req.params.id, gymId],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Plan not found or not active' });
  const { rows } = await db.query('SELECT * FROM membership_plans WHERE id = ?', [req.params.id]);
  res.json(await enrichPlan(rows[0], gymId));
});

// ─── Enrollment toggle ────────────────────────────────────────────────────────

membershipPlansRouter.put('/:id/enrollment', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { enrollment_status } = req.body;
  if (!['public', 'staff_only'].includes(enrollment_status)) {
    return res.status(400).json({ error: 'enrollment_status must be public or staff_only' });
  }
  const { rows: plan } = await db.query(
    'SELECT lifecycle_status FROM membership_plans WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [req.params.id, gymId],
  );
  if (plan.length === 0) return res.status(404).json({ error: 'Plan not found' });
  if (['public', 'staff_only'].includes(enrollment_status) && plan[0].lifecycle_status !== 'active') {
    return res.status(400).json({ error: 'Cannot open enrollment on a non-active plan' });
  }
  const callerMemberId = await getCallerMembershipId(req);
  await db.query(
    'UPDATE membership_plans SET enrollment_status = ?, modified_at = NOW(), modified_by = ? WHERE id = ? AND gym_id = ?',
    [enrollment_status, callerMemberId, req.params.id, gymId],
  );
  const { rows } = await db.query('SELECT * FROM membership_plans WHERE id = ?', [req.params.id]);
  res.json(await enrichPlan(rows[0], gymId));
});

// ─── Billing policy ───────────────────────────────────────────────────────────

membershipPlansRouter.get('/:id/billing-policy', async (req, res) => {
  const { gymId } = getTenantContext(req);
  if (!(await planExists(req.params.id, gymId))) return res.status(404).json({ error: 'Plan not found' });
  const { rows } = await db.query(
    'SELECT * FROM billing_policies WHERE membership_plan_id = ? AND gym_id = ?',
    [req.params.id, gymId],
  );
  res.json(rows[0] ?? null);
});

membershipPlansRouter.put('/:id/billing-policy', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  if (!(await planExists(req.params.id, gymId))) return res.status(404).json({ error: 'Plan not found' });
  const { recurring_billing_interval, recurring_billing_unit, auto_renew } = req.body;
  // #635 stage 13: the Billing frequency is now the section's only cadence, so
  // it is validated here rather than left to the column defaults — a half-sent
  // or nonsense pair used to reach the DB and either throw or quietly store a
  // cadence nobody configured, and this pair is what every assignment of the
  // plan snapshots and bills on.
  const interval = Number(recurring_billing_interval);
  if (!Number.isInteger(interval) || interval < 1) {
    return res.status(400).json({ error: 'recurring_billing_interval must be a positive integer' });
  }
  if (!BILLING_UNITS.includes(recurring_billing_unit)) {
    return res.status(400).json({ error: `recurring_billing_unit must be one of: ${BILLING_UNITS.join(', ')}` });
  }
  // #820: the Billing frequency is a choice of two — Month (1 month) or 4 Weeks
  // (4 week). The pair stays the wire format and the stored shape, so nothing
  // downstream changes; this is the one place that decides a Plan may not be
  // configured with a cadence nobody sells, which is what keeps the single
  // dropdown from being a frontend-only rule.
  if (!isAcceptedPlanCadence(interval, recurring_billing_unit)) {
    return res.status(400).json({
      error: `recurring_billing_interval/recurring_billing_unit must be one of: ${describeAcceptedPlanCadences()}`,
    });
  }
  try {
    await db.query(
      `INSERT INTO billing_policies
       (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit, auto_renew)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        recurring_billing_interval  = VALUES(recurring_billing_interval),
        recurring_billing_unit      = VALUES(recurring_billing_unit),
        auto_renew                  = VALUES(auto_renew)`,
      [gymId, req.params.id, interval, recurring_billing_unit, auto_renew ?? true],
    );
    const { rows } = await db.query(
      'SELECT * FROM billing_policies WHERE membership_plan_id = ? AND gym_id = ?',
      [req.params.id, gymId],
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ─── Example timeline (#485, reshaped by #818) ─────────────────────────────────
// Read-only, dynamically calculated — never persisted. Reuses the same
// calculation `enrichPlan` embeds as `example_timeline` on every Plan. #818
// renamed the route with the section: the Billing Events Forecast it served
// (the next ten charges, the durations ignored) no longer exists.

membershipPlansRouter.get('/:id/example-timeline', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query<PlanRow>(
    'SELECT * FROM membership_plans WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [req.params.id, gymId],
  );
  if (!rows[0]) return res.status(404).json({ error: 'Plan not found' });
  const enriched = await enrichPlan(rows[0], gymId) as { example_timeline: unknown };
  res.json(enriched.example_timeline);
});

// ─── Billing Event Simulation (#915) ──────────────────────────────────────────
// Read-only, dynamically calculated — never persisted, and it creates no billing
// event, invoice or payment record. Reuses the same calculation `enrichPlan`
// embeds as `billing_event_simulation` on every Plan, exactly as the Example
// timeline route above does, so the card and this endpoint cannot disagree.

membershipPlansRouter.get('/:id/billing-event-simulation', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query<PlanRow>(
    'SELECT * FROM membership_plans WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [req.params.id, gymId],
  );
  if (!rows[0]) return res.status(404).json({ error: 'Plan not found' });
  const enriched = await enrichPlan(rows[0], gymId) as { billing_event_simulation: unknown };
  res.json(enriched.billing_event_simulation);
});

// ─── Centers ──────────────────────────────────────────────────────────────────

membershipPlansRouter.get('/:id/centers', async (req, res) => {
  const { gymId } = getTenantContext(req);
  if (!(await planExists(req.params.id, gymId))) return res.status(404).json({ error: 'Plan not found' });
  const { rows } = await db.query(
    `SELECT mpc.center_id AS id, c.name
     FROM membership_plan_centers mpc
     JOIN centers c ON c.id = mpc.center_id
     WHERE mpc.membership_plan_id = ? AND mpc.gym_id = ?`,
    [req.params.id, gymId],
  );
  res.json(rows);
});

membershipPlansRouter.put('/:id/centers', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  if (!(await planExists(req.params.id, gymId))) return res.status(404).json({ error: 'Plan not found' });
  const { center_ids } = req.body;
  if (!Array.isArray(center_ids)) return res.status(400).json({ error: 'center_ids must be an array' });
  try {
    await db.query('DELETE FROM membership_plan_centers WHERE membership_plan_id = ? AND gym_id = ?', [req.params.id, gymId]);
    for (const cid of center_ids) {
      await db.query(
        'INSERT INTO membership_plan_centers (gym_id, membership_plan_id, center_id) VALUES (?, ?, ?)',
        [gymId, req.params.id, cid],
      );
    }
    const { rows } = await db.query(
      `SELECT mpc.center_id AS id, c.name
       FROM membership_plan_centers mpc
       JOIN centers c ON c.id = mpc.center_id
       WHERE mpc.membership_plan_id = ? AND mpc.gym_id = ?`,
      [req.params.id, gymId],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ─── Prices (kept from original) ──────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// #547: the row whose validity window covers today is the plan's current price.
// Ties (a window replaced earlier the same day keeps a same-day closed window)
// are broken in favour of the row that is not history yet, then by recency.
const CURRENT_PRICE_SQL = `
  SELECT * FROM membership_plan_prices
   WHERE membership_plan_id = ? AND gym_id = ?
     AND valid_from <= UTC_DATE() AND (valid_to IS NULL OR valid_to >= UTC_DATE())
   ORDER BY (status = 'inactive') ASC, valid_from DESC, id DESC
   LIMIT 1`;

async function loadCurrentPriceRow(q: Tx, planId: number | string | string[], gymId: string): Promise<PriceRow | null> {
  const { rows } = await q.query<PriceRow>(CURRENT_PRICE_SQL, [planId, gymId]);
  return rows[0] ?? null;
}

/**
 * Re-derives every price row's status for one plan from its validity windows:
 * the window covering today is the current price, everything else is history.
 * A current price that was already pushed onto the plan's Assigned Plans keeps
 * its 'applied' marker. Called after any write that can move the windows, so
 * the status column can never drift from the dates it describes.
 */
async function recomputePriceStatuses(q: Tx, planId: number | string | string[], gymId: string): Promise<void> {
  const current = await loadCurrentPriceRow(q, planId, gymId);
  await q.query(
    `UPDATE membership_plan_prices SET status = 'inactive'
      WHERE membership_plan_id = ? AND gym_id = ? AND id <> ?`,
    [planId, gymId, current ? current.id : 0],
  );
  if (current) {
    await q.query(
      `UPDATE membership_plan_prices
          SET status = IF(applied_at IS NULL, 'active', 'applied')
        WHERE id = ? AND gym_id = ?`,
      [current.id, gymId],
    );
  }
}

function parsePriceBody(body: Record<string, unknown>): { price: number; from: string; to: string | null } | string {
  const price = body.price as string | number | null | undefined;
  const valid_from = body.valid_from as string | null | undefined;
  const valid_to = body.valid_to as string | null | undefined;
  const parsed = parseFloat(price as string);
  if (price == null || isNaN(parsed) || parsed < 0) return 'price must be a non-negative number';
  if (!valid_from || !DATE_RE.test(valid_from)) return 'valid_from is required (YYYY-MM-DD)';
  const to = valid_to == null || valid_to === '' ? null : valid_to;
  if (to !== null && !DATE_RE.test(to)) return 'valid_to must be a date (YYYY-MM-DD) or empty';
  if (to !== null && to < valid_from) return 'valid_to must be on or after valid_from';
  return { price: parsed, from: valid_from, to };
}

async function overlaps(planId: string | string[], from: string, to: string | null, excludeId?: string | string[]): Promise<boolean> {
  const params: (string | string[])[] = [planId, from];
  let sql = `SELECT 1 FROM membership_plan_prices
             WHERE membership_plan_id = ?
               AND (valid_to IS NULL OR valid_to >= ?)`;
  if (to !== null) { sql += ' AND valid_from <= ?'; params.push(to); }
  if (excludeId) { sql += ' AND id <> ?'; params.push(excludeId); }
  sql += ' LIMIT 1';
  const { rows } = await db.query(sql, params);
  return rows.length > 0;
}

membershipPlansRouter.get('/:id/prices', async (req, res) => {
  const { gymId } = getTenantContext(req);
  if (!(await planExists(req.params.id, gymId))) return res.status(404).json({ error: 'Plan not found' });
  const { rows } = await db.query(
    'SELECT * FROM membership_plan_prices WHERE membership_plan_id = ? AND gym_id = ? ORDER BY valid_from ASC',
    [req.params.id, gymId],
  );
  res.json(rows);
});

membershipPlansRouter.post('/:id/prices', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  if (!(await planExists(req.params.id, gymId))) return res.status(404).json({ error: 'Plan not found' });
  const parsed = parsePriceBody(req.body);
  if (typeof parsed === 'string') return res.status(400).json({ error: parsed });
  if (await overlaps(req.params.id, parsed.from, parsed.to)) {
    return res.status(400).json({ error: 'This validity window overlaps an existing price for this plan.' });
  }
  try {
    const { insertId } = await db.query(
      `INSERT INTO membership_plan_prices (membership_plan_id, gym_id, price, valid_from, valid_to, tax_rate_id, tax_rate_percent)
       SELECT ?, ?, ?, ?, ?, mp.tax_rate_id, tr.rate_percent
         FROM membership_plans mp
         LEFT JOIN tax_rates tr ON tr.id = mp.tax_rate_id
        WHERE mp.id = ? AND mp.gym_id = ?`,
      [req.params.id, gymId, parsed.price, parsed.from, parsed.to, req.params.id, gymId],
    );
    await recomputePriceStatuses(db, req.params.id, gymId);
    const { rows } = await db.query('SELECT * FROM membership_plan_prices WHERE id = ?', [insertId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

membershipPlansRouter.put('/:id/prices/:priceId', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  if (!(await planExists(req.params.id, gymId))) return res.status(404).json({ error: 'Plan not found' });
  const parsed = parsePriceBody(req.body);
  if (typeof parsed === 'string') return res.status(400).json({ error: parsed });
  if (await overlaps(req.params.id, parsed.from, parsed.to, req.params.priceId)) {
    return res.status(400).json({ error: 'This validity window overlaps an existing price for this plan.' });
  }
  try {
    const { rowCount } = await db.query(
      `UPDATE membership_plan_prices SET price = ?, valid_from = ?, valid_to = ?
       WHERE id = ? AND membership_plan_id = ? AND gym_id = ?`,
      [parsed.price, parsed.from, parsed.to, req.params.priceId, req.params.id, gymId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Price not found' });
    await recomputePriceStatuses(db, req.params.id, gymId);
    const { rows } = await db.query('SELECT * FROM membership_plan_prices WHERE id = ?', [req.params.priceId]);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

membershipPlansRouter.delete('/:id/prices/:priceId', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rowCount } = await db.query(
    'DELETE FROM membership_plan_prices WHERE id = ? AND membership_plan_id = ? AND gym_id = ?',
    [req.params.priceId, req.params.id, gymId],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Price not found' });
  await recomputePriceStatuses(db, req.params.id, gymId);
  res.status(204).send();
});

// ─── Pricing (#547) ───────────────────────────────────────────────────────────
// The Pricing section edits one thing: what the plan costs today, VAT included.
// Saving closes the current price window and opens a new one, so the superseded
// price stays in the history exactly as it was (req. 15 — historical rows are
// never recomputed, only closed).

const ASSIGNABLE_STATUSES = ['active', 'paused'];

function round2(value: number): number {
  return parseFloat(value.toFixed(2));
}

membershipPlansRouter.put('/:id/pricing', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { rows: planRows } = await db.query<PlanRow>(
    'SELECT * FROM membership_plans WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [req.params.id, gymId],
  );
  if (planRows.length === 0) return res.status(404).json({ error: 'Plan not found' });
  const plan = planRows[0];

  const rawPrice = req.body.price;
  const price = parseFloat(rawPrice as string);
  if (rawPrice == null || rawPrice === '' || isNaN(price) || price < 0) {
    return res.status(400).json({ error: 'price must be a non-negative number' });
  }
  const taxRateErr = await validateTaxRateId(gymId, req.body.tax_rate_id);
  if (taxRateErr) return res.status(400).json({ error: taxRateErr });

  // An explicit tax_rate_id wins; an explicit null/'' means "gym default" (the
  // system rate, mirroring POST /); omitting the key leaves the plan's rate as is.
  const providedTaxRateId = req.body.tax_rate_id;
  const nextTaxRateId = providedTaxRateId != null && providedTaxRateId !== ''
    ? Number(providedTaxRateId)
    : 'tax_rate_id' in req.body
      ? await getSystemTaxRateId(gymId)
      : (plan.tax_rate_id ?? await getSystemTaxRateId(gymId));

  const value = round2(price);
  const callerMemberId = await getCallerMembershipId(req);
  const { rows: nextTaxRows } = nextTaxRateId == null
    ? { rows: [] as { rate_percent: string }[] }
    : await db.query<{ rate_percent: string }>(
        'SELECT rate_percent FROM tax_rates WHERE id = ? AND gym_id = ?',
        [nextTaxRateId, gymId],
      );
  const nextRatePercent = nextTaxRows[0] ? nextTaxRows[0].rate_percent : null;

  try {
    await db.transaction(async (tx) => {
      const current = await loadCurrentPriceRow(tx, plan.id, gymId);
      // A VAT change is a pricing change too: the current row keeps the rate it
      // was priced with and a new row opens under the new one.
      const changed = current == null
        || round2(parseFloat(current.price)) !== value
        || (current.tax_rate_id ?? null) !== (nextTaxRateId ?? null);

      if (changed) {
        if (current) {
          // A window opened on an earlier day closes yesterday; one opened today
          // closes today, so the history still records that it was in force.
          await tx.query(
            `UPDATE membership_plan_prices
                SET status = 'inactive',
                    valid_to = IF(valid_from < UTC_DATE(), DATE_SUB(UTC_DATE(), INTERVAL 1 DAY), valid_from)
              WHERE id = ? AND gym_id = ?`,
            [current.id, gymId],
          );
        }
        await tx.query(
          `INSERT INTO membership_plan_prices
             (membership_plan_id, gym_id, price, valid_from, valid_to, status, tax_rate_id, tax_rate_percent)
           VALUES (?, ?, ?, UTC_DATE(), NULL, 'active', ?, ?)`,
          [plan.id, gymId, value, nextTaxRateId ?? null, nextRatePercent],
        );
      }

      // Price is always the final, VAT-inclusive customer price (req. 6/7), so
      // the plan's tax behavior is fixed — only the rate is selectable.
      await tx.query(
        `UPDATE membership_plans
            SET tax_rate_id = ?, tax_behavior = 'inclusive', modified_at = UTC_TIMESTAMP(), modified_by = ?
          WHERE id = ? AND gym_id = ?`,
        [nextTaxRateId, callerMemberId, plan.id, gymId],
      );
      await recomputePriceStatuses(tx, plan.id, gymId);
    });

    const { rows } = await db.query<PlanRow>('SELECT * FROM membership_plans WHERE id = ?', [plan.id]);
    recordAudit(req, {
      action: 'update',
      entityType: 'membership_plan',
      entityId: plan.id,
      previous: { price: null, tax_rate_id: plan.tax_rate_id },
      next: { price: value, tax_rate_id: nextTaxRateId },
    });
    res.json(await enrichPlan(rows[0], gymId));
  } catch (err) {
    next(err);
  }
});

// Pushes the plan's current price onto the Assigned Plans that still run on it.
// Terminal (cancelled/expired) memberships and already-generated Billing Events
// are never touched — this only changes what an ongoing Assigned Plan costs from
// now on. A negotiated fee (an Assigned Plan with a discount_reason) keeps the
// price that was agreed for it; only its plan-price reference is refreshed.
//
// #635 stage 15: the number that decides what an assignment bills is its own
// frozen `membership_fee_price`, so that is what this writes — `final_price` is
// gone, and writing only `base_price`/`plan_price_id` (as this did) would leave
// every assignment billing the price it was created with. Writing it makes the
// assignment "captured" for the all-or-nothing snapshot rule, so each row is
// materialised first (see `materialiseAssignedPlanSnapshot`) — otherwise a row
// that never got a snapshot would flip to captured with empty benefit sections.
membershipPlansRouter.post('/:id/pricing/apply-to-assigned-plans', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  if (!(await planExists(req.params.id, gymId))) return res.status(404).json({ error: 'Plan not found' });

  const current = await loadCurrentPriceRow(db, req.params.id, gymId);
  if (!current) return res.status(400).json({ error: 'This plan has no current price to apply.' });
  const price = round2(parseFloat(current.price));
  const statusMarks = ASSIGNABLE_STATUSES.map(() => '?').join(',');

  try {
    const result = await db.transaction(async (tx) => {
      const { rows: repriced } = await tx.query(
        `SELECT id, starts_at FROM user_memberships
          WHERE membership_plan_id = ? AND gym_id = ? AND status IN (${statusMarks})
            AND (discount_reason IS NULL OR discount_reason = '')
          FOR UPDATE`,
        [req.params.id, gymId, ...ASSIGNABLE_STATUSES],
      );
      for (const row of repriced) {
        await materialiseAssignedPlanSnapshot(tx, {
          gymId, userMembershipId: Number(row.id),
          membershipPlanId: Number(req.params.id),
          // The fee it bills today, so materialising changes nothing on its own;
          // the UPDATE below is what moves it to the Plan's new price.
          membershipFeePrice: await snapshotFeeForAssignment(gymId, row),
        });
      }
      const { rowCount: updated } = await tx.query(
        `UPDATE user_memberships
            SET base_price = ?, plan_price_id = ?, membership_fee_price = ?
          WHERE membership_plan_id = ? AND gym_id = ? AND status IN (${statusMarks})
            AND (discount_reason IS NULL OR discount_reason = '')`,
        [price, current.id, price, req.params.id, gymId, ...ASSIGNABLE_STATUSES],
      );
      const { rowCount: keptDiscounted } = await tx.query(
        `UPDATE user_memberships
            SET base_price = ?, plan_price_id = ?
          WHERE membership_plan_id = ? AND gym_id = ? AND status IN (${statusMarks})
            AND discount_reason IS NOT NULL AND discount_reason <> ''`,
        [price, current.id, req.params.id, gymId, ...ASSIGNABLE_STATUSES],
      );
      await tx.query(
        `UPDATE membership_plan_prices SET status = 'applied', applied_at = UTC_TIMESTAMP() WHERE id = ? AND gym_id = ?`,
        [current.id, gymId],
      );
      return { updated, kept_discounted: keptDiscounted };
    });

    recordAudit(req, {
      action: 'update',
      entityType: 'membership_plan',
      entityId: req.params.id,
      next: { applied_price: price, plan_price_id: current.id, ...result },
    });
    res.json({ price, ...result });
  } catch (err) {
    next(err);
  }
});

// ─── Session / One-off / Period Benefits (#635 stage 1) ───────────────────────
// The same three Product-keyed sections a Promotion has had since #550,
// now on the Membership Plan itself (migration 173). Deliberately a copy of the
// Promotion contract in `promotion-details.ts` rather than a new one — the
// ticket asks for sections that "behave like the existing ... Benefits in
// Promotions", and the admin editors are shared, so the payload
// (`{ items: [{ product_id, quantity }] }`, replace-all) and every rejection
// must match what the Promotion endpoints already do.
//
// Since stage 3 (#714) these sections are what an assignment bills from, via
// the snapshot it captures at assignment time. They are also all the Plan has
// now: Charge Benefits were retired in stage 4 part 1 (migration 176) and
// Included Services in part 2 (migration 177), the latter because the relation
// it expressed belongs to the Activity Type (`activity_type_eligible_plans`)
// rather than to the Plan — see the note in that migration's header.

function selectPlanProductBenefits(table: string): string {
  // #915: the price columns are here so the Billing Event Simulation can gross
  // up a configured line without a second round trip — and from the benefit
  // row's own join rather than the active catalogue, since a Plan may still
  // carry (and still bill) an item that has since been deactivated.
  return `SELECT b.*, gc.name AS product_name, gc.type AS product_type,
                 gc.billing_frequency AS product_billing_frequency, gc.status AS product_status,
                 gc.mandatory AS product_mandatory,
                 gc.amount AS product_amount, gc.tax_behavior AS product_tax_behavior,
                 tr.rate_percent AS product_tax_rate_percent
          FROM ${table} b
          JOIN products gc ON gc.id = b.product_id
          LEFT JOIN tax_rates tr ON tr.id = gc.tax_rate_id
          WHERE b.membership_plan_id = ? AND b.gym_id = ?
          ORDER BY product_name ASC`;
}

/**
 * One Plan section's stored rows, with the `(action, value)` pair normalized
 * (#896 stage 2): `value` a number rather than mysql2's `DECIMAL` string, and
 * an action a Plan may not configure — `fixed_discount`, `fixed_price`, §16 —
 * read back as the neutral default rather than leaking into the Plan editor.
 */
async function loadPlanBenefits(
  table: string, planId: unknown, gymId: string,
): Promise<PlanProductBenefitRow[]> {
  const { rows } = await db.query<PlanProductBenefitRow>(
    selectPlanProductBenefits(table), [planId, gymId],
  );
  return rows.map((row) => {
    const shaped = shapeProductBenefitRow('plan', row) as PlanProductBenefitRow;
    // #918: `b.*` brings the column along raw; normalize it so the wire shape is
    // a known frequency or `null`, exactly as the snapshot's reader does.
    if ('frequency' in row) shaped.frequency = toSessionBenefitFrequency(row.frequency);
    return shaped;
  });
}

/**
 * #893: the gym's mandatory Products, as candidates for the rule in
 * `domain/mandatoryPlanBenefits.ts`. Active and non-deleted only — a mandatory
 * item that has been deactivated or deleted is not something a Plan can be
 * forced to carry, and the benefit `PUT` already refuses a newly selected
 * inactive item. `enrichPlan` does not call this: it already has the same
 * catalogue in hand for the Benefit pickers.
 */
async function loadMandatoryProducts(gymId: string): Promise<MandatoryProduct[]> {
  const { rows } = await db.query<MandatoryProduct>(
    // #916: the price columns come along, so an implicit row quotes its
    // Original and Final Price like a stored one instead of reading "—".
    `SELECT gc.id, gc.name, gc.type, gc.billing_frequency, gc.status, gc.mandatory,
            gc.amount, gc.tax_behavior, tr.rate_percent AS tax_rate_percent
       FROM products gc
       LEFT JOIN tax_rates tr ON tr.id = gc.tax_rate_id
      WHERE gc.gym_id = ? AND gc.deleted_at IS NULL AND gc.status = 'active' AND gc.mandatory = 1
      ORDER BY gc.name ASC`,
    [gymId],
  );
  return rows;
}

const PLAN_BENEFIT_ROUTES: { path: string; category: ProductBenefitCategory }[] = [
  { path: 'session-benefits', category: 'session' },
  { path: 'oneoff-benefits', category: 'oneoff' },
  { path: 'periodical-benefits', category: 'periodical' },
];

for (const { path, category } of PLAN_BENEFIT_ROUTES) {
  const table = planBenefitTableForCategory(category);
  // #918: only `membership_plan_session` carries a renewal Frequency.
  const isSessionSection = category === 'session';

  membershipPlansRouter.get(`/:id/${path}`, async (req, res, next) => {
    const { gymId } = getTenantContext(req);
    try {
      if (!(await planExists(req.params.id, gymId))) return res.status(404).json({ error: 'Plan not found' });
      const rows = await loadPlanBenefits(table, req.params.id, gymId);
      // #893 §1/§5: a mandatory item is part of the section whether or not this
      // Plan has a row for it — the editor and the read-only view both read this.
      const mandatory = mandatoryItemsForCategory(await loadMandatoryProducts(gymId), category);
      // #916: the section's own endpoint reports the same Original / Final
      // Price pair `enrichPlan` embeds, so the card and a refetch of one
      // section cannot disagree about what a line costs.
      res.json(withPlanBenefitPrices(mergeMandatoryBenefits(rows, mandatory)));
    } catch (err) { next(err); }
  });

  membershipPlansRouter.put(`/:id/${path}`, requireRole('admin'), async (req, res, next) => {
    const { gymId } = getTenantContext(req);
    const planId = parseInt(String(req.params.id), 10);
    const { items } = req.body;
    if (!Array.isArray(items)) return res.status(400).json({ error: 'items must be an array' });
    if (!(await planExists(req.params.id, gymId))) return res.status(404).json({ error: 'Plan not found' });

    const productIds: number[] = [];
    const submitted: PlanBenefitWrite[] = [];
    const seen = new Set<number>();
    for (const item of items) {
      const productId = parseInt(item.product_id, 10);
      const quantity = parseInt(item.quantity, 10);
      if (!Number.isInteger(productId) || productId <= 0) {
        return res.status(400).json({ error: 'product_id is required' });
      }
      if (!Number.isInteger(quantity) || quantity <= 0) {
        return res.status(400).json({ error: 'quantity must be a positive integer' });
      }
      if (seen.has(productId)) {
        return res.status(400).json({ error: `Duplicate product_id: ${productId}` });
      }
      // #896 stage 2 §5/§16 — a Plan may configure three of the five actions;
      // `Fixed discount` and `Fixed Price` are a 400 here and a CHECK violation
      // in SQL, so the dropdown is never what enforces it.
      const parsed = parseProductBenefitInput('plan', item);
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      // #918 — the Session Benefit's renewal Frequency, on the one section that
      // has the column. A value sent to the other two is ignored rather than
      // refused: the editor is shared, and no row there could store one.
      const frequency = category === 'session'
        ? parseSessionBenefitFrequencyInput(item)
        : { keep: true as const };
      if (frequency.error) return res.status(400).json({ error: frequency.error });
      seen.add(productId);
      productIds.push(productId);
      submitted.push({
        product_id: productId, quantity, benefit: parsed.benefit,
        // Absent means the request named none, which is *keep what is stored* —
        // the same rule the `(action, value)` pair follows, and what stops a
        // quantity-only save clearing a configured Frequency.
        ...(frequency.keep ? {} : { frequency: frequency.frequency }),
      });
    }

    if (productIds.length > 0) {
      // Only *newly* selected items must be active — an item already attached to
      // this plan stays selectable after it goes inactive elsewhere, so an
      // unrelated catalog change never 400s the whole save or silently drops a
      // pre-existing selection. Same rule as the Promotion benefits and
      // Suitable Membership Plans.
      const { rows: existingAssoc } = await db.query(
        `SELECT product_id FROM ${table} WHERE membership_plan_id = ? AND gym_id = ?`,
        [planId, gymId],
      );
      const existingIds = new Set<number>(existingAssoc.map((r: any) => r.product_id));

      const placeholders = productIds.map(() => '?').join(',');
      const { rows: products } = await db.query(
        `SELECT id, type, billing_frequency, status FROM products
         WHERE gym_id = ? AND deleted_at IS NULL AND id IN (${placeholders})`,
        [gymId, ...productIds],
      );
      if (products.length !== productIds.length) {
        return res.status(400).json({ error: 'One or more Products not found in this gym' });
      }
      const newlyInactive = products.find((si: any) => si.status !== 'active' && !existingIds.has(si.id));
      if (newlyInactive) {
        return res.status(400).json({ error: `Product ${newlyInactive.id} is not active in this gym` });
      }
      const mismatched = products.find((si: any) => classifyProduct(si) !== category);
      if (mismatched) {
        return res.status(400).json({ error: `Product ${mismatched.id} does not belong in the '${category}' category` });
      }
    }

    // #893 §7: the client cannot drop a mandatory item, whatever it sends.
    // Preserving it rather than 400ing is the ticket's own alternative and is
    // what makes §5 work — the first save of any section is when an existing
    // Plan picks up an item that became mandatory after it was configured.
    // A mandatory item the client *did* send passes through untouched, quantity
    // included (§4), and §8's no-duplicates rule is the merge's `has` check.
    const mandatory = mandatoryItemsForCategory(await loadMandatoryProducts(gymId), category);
    const toWrite = withMandatoryBenefits(submitted, mandatory);

    const callerMemberId = await getCallerMembershipId(req);
    try {
      await db.transaction(async (tx) => {
        // #896 stage 2: a replace-all must not rewrite what it was not asked
        // about — a line the request named no treatment for keeps the one it is
        // stored with, which is also what a mandatory item re-added by
        // `withMandatoryBenefits()` gets, so preserving an item can never
        // change what it costs.
        const { rows: stored } = await tx.query(
          `SELECT product_id, \`action\`, \`value\`${isSessionSection ? ', frequency' : ''} FROM ${table}
            WHERE membership_plan_id = ? AND gym_id = ? FOR UPDATE`,
          [planId, gymId],
        );
        const kept = new Map<number, ProductBenefit>(
          stored.map((r: any) => [Number(r.product_id), shapeProductBenefitRow('plan', r)]),
        );
        // #918: and the Frequency it is stored with, for the same replace-all
        // reason — a save that never mentions it must not clear it.
        const keptFrequency = new Map<number, SessionBenefitFrequency | null>(
          stored.map((r: any) => [Number(r.product_id), toSessionBenefitFrequency(r.frequency)]),
        );
        await tx.query(`DELETE FROM ${table} WHERE membership_plan_id = ? AND gym_id = ?`, [planId, gymId]);
        for (const item of toWrite) {
          const benefit = item.benefit ?? kept.get(item.product_id) ?? NO_PRODUCT_BENEFIT;
          const frequency = item.frequency !== undefined
            ? item.frequency
            : (keptFrequency.get(item.product_id) ?? null);
          await tx.query(
            `INSERT INTO ${table}
               (gym_id, membership_plan_id, product_id, quantity, \`action\`, \`value\`,
                created_by_membership_id${isSessionSection ? ', frequency' : ''})
             VALUES (?, ?, ?, ?, ?, ?, ?${isSessionSection ? ', ?' : ''})`,
            [
              gymId, planId, item.product_id, item.quantity, benefit.action, benefit.value,
              callerMemberId,
              ...(isSessionSection ? [frequency] : []),
            ],
          );
        }
      });
      recordAudit(req, { action: 'update', entityType: 'membership_plan', entityId: planId, next: { [`${category}_benefits`]: toWrite } });
      res.json(withPlanBenefitPrices(
        mergeMandatoryBenefits(await loadPlanBenefits(table, planId, gymId), mandatory)));
    } catch (err) { next(err); }
  });
}
