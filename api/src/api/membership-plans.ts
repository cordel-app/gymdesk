import { Router, Request } from 'express';
import { db, Tx } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { handleDupEntry, insertAndFetch } from '../infra/db-helpers';
import {
  attachMembershipFees,
  effectivePrice,
  LIST_SELECT as MEMBERSHIP_LIST_SELECT,
  MEMBERS_SELECT as MEMBERSHIP_MEMBERS_SELECT,
} from './user-memberships';
import { recordStatusChange, sourceForRole } from './billing-events';
import { applyPromotionToMembership } from './membership-promotions';
import { materialiseAssignedPlanSnapshot, snapshotAssignedPlan } from './assigned-plan-snapshot';
import { computePriceFields, validateTaxRateId } from './sellable-items';
import { computeBillingForecast } from '../domain/billingForecast';
import {
  classifySellableItem,
  planBenefitTableForCategory,
  SellableItemBenefitCategory,
} from '../domain/sellableItemClassification';

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
  free_months: number | null;
  paid_months: number | null;
  bonus_months: number | null;
  // #635 stage 13 — Pre-paid Duration: how many of `paid_months` are already
  // paid up front (the Promotion's own `pay_beforehand_months`, migration 189).
  pay_beforehand_months: number | null;
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
// (migration 173). `gym_charge_*` comes from the join, so an item that has
// since gone inactive still resolves to its real name and status instead of a
// bare id — same shape the Promotion benefit endpoints return.
interface PlanSellableItemBenefitRow {
  id: number;
  gym_id: string;
  membership_plan_id: number;
  gym_charge_id: number;
  quantity: number;
  gym_charge_name: string;
  gym_charge_type: string;
  gym_charge_billing_frequency: string | null;
  gym_charge_status: string;
}

interface SellableItemRow {
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
}

export const membershipPlansRouter = Router();

const VALID_MEMBER_LIMIT = ['1', '2', 'family'];
const VALID_TAX_BEHAVIORS = ['inclusive', 'exclusive'];
// The `billing_policies.recurring_billing_unit` ENUM (migration 060) — the one
// cadence a Plan still carries after stage 13 (migration 189).
const BILLING_UNITS = ['day', 'week', 'month', 'year'];

// #635 §7: Billing & Duration, with the Promotion's semantics (migration 102) —
// whole months, never negative. Sent together by the section's own Save, and an
// empty field clears the value back to "not configured" rather than writing 0.
const DURATION_FIELDS = ['free_months', 'paid_months', 'bonus_months', 'pay_beforehand_months'] as const;

/** null = absent (leave as is), or a parsed non-negative integer. Throws the error string for a bad value. */
function parseDurationMonths(raw: unknown, field: string): number | null | string {
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
  const [prices, bpRows, centers, memberCount, sellableItems, taxRateRows, promotionCount,
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
    // Full catalog of active sellable items for this gym, so the admin UI can
    // populate the Benefit selectors without a separate round trip.
    db.query<SellableItemRow>(
      `SELECT gc.id, gc.gym_id, gc.name, gc.type, gc.amount, gc.currency, gc.billing_frequency,
              gc.status, gc.availability, gc.enrollment_status, gc.is_system,
              ct.code AS charge_type_code, ct.name AS charge_type_name
       FROM gym_charges gc
       LEFT JOIN charge_types ct ON ct.id = gc.charge_type_id
       WHERE gc.gym_id = ? AND gc.deleted_at IS NULL AND gc.status = 'active'
       ORDER BY gc.is_system DESC, gc.name ASC`,
      [gymId],
    ).then(r => r.rows),
    plan.tax_rate_id == null
      ? Promise.resolve([])
      : db.query<{ name: string; rate_percent: string }>(
          'SELECT name, rate_percent FROM tax_rates WHERE id = ? AND gym_id = ?',
          [plan.tax_rate_id, gymId],
        ).then(r => r.rows),
    // #512: promotion count for the Membership Plan Details modal's compact summary.
    db.query(
      `SELECT COUNT(*) AS n
       FROM promotion_membership_plans pmp
       JOIN promotions p ON p.id = pmp.promotion_id
       WHERE pmp.membership_plan_id = ? AND pmp.gym_id = ? AND p.deleted_at IS NULL`,
      [plan.id, gymId],
    ).then(r => Number(r.rows[0].n)),
    // #635 stage 1: the three Sellable-Item-keyed Benefit sections (migration
    // 173), served with the plan so the Plans page renders them without three
    // extra round trips per card — same reason `sellable_items` is inlined above.
    ...(['session', 'oneoff', 'periodical'] as SellableItemBenefitCategory[]).map(category =>
      db.query<PlanSellableItemBenefitRow>(
        selectPlanSellableItemBenefits(planBenefitTableForCategory(category)),
        [plan.id, gymId],
      ).then(r => r.rows),
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

  const taxRate = taxRateRows[0] ?? null;
  const priceFields = computePriceFields({
    amount: currentPrice ? currentPrice.price : null,
    tax_rate_percent: taxRate ? taxRate.rate_percent : null,
    tax_behavior: plan.tax_behavior,
  });

  const billingPolicy = bpRows[0] ?? null;
  const billingForecast = computeBillingForecast({
    planName: plan.name,
    price: currentPrice ? parseFloat(currentPrice.price) : null,
    recurringBillingInterval: billingPolicy ? billingPolicy.recurring_billing_interval : null,
    recurringBillingUnit: (billingPolicy ? billingPolicy.recurring_billing_unit : null) as any,
    // #635 stage 4: Charge Benefits were the only source of benefit lines, and
    // they are gone. The forecast is now the plan fee and its cadence alone —
    // `computeBillingForecast` keeps supporting benefit lines because the
    // Assigned Plan's own projection (billing-simulation.ts) still applies
    // Promotion benefits to a charge.
    benefitLines: [],
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

  return {
    ...plan,
    current_price: currentPrice ? currentPrice.price : null,
    price_history: priceHistory,
    billing_policy: billingPolicy,
    centers,
    member_count: memberCount,
    promotion_count: promotionCount,
    session_benefits: sessionBenefits,
    oneoff_benefits: oneoffBenefits,
    periodical_benefits: periodicalBenefits,
    sellable_items: sellableItems,
    tax_rate_name: taxRate ? taxRate.name : null,
    tax_rate_percent: taxRate ? taxRate.rate_percent : null,
    ...priceFields,
    // #485: read-only, dynamically computed — never persisted (see docs/architecture.md).
    billing_forecast: { ...billingForecast, currency: 'EUR' },
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
    const parsed = parseDurationMonths(req.body[field], field);
    if (typeof parsed === 'string') return res.status(400).json({ error: parsed });
    durations[field] = parsed;
  }
  // #635 stage 13: the Pre-paid Duration is a slice of the Paid Duration, the
  // Promotion's own 0..paid_months bound (`validatePayBeforehandMonths`).
  // Checked against the plan as it will stand, because either field can be sent
  // on its own and either one alone can break the bound.
  if ('pay_beforehand_months' in req.body || 'paid_months' in req.body) {
    const { rows: current } = await db.query(
      `SELECT paid_months, pay_beforehand_months FROM membership_plans
       WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
      [req.params.id, gymId],
    );
    if (!current[0]) return res.status(404).json({ error: 'Plan not found' });
    const nextPaid = 'paid_months' in req.body ? durations.paid_months : current[0].paid_months;
    const nextPrepaid = 'pay_beforehand_months' in req.body
      ? durations.pay_beforehand_months : current[0].pay_beforehand_months;
    if (nextPrepaid != null && Number(nextPrepaid) > Number(nextPaid ?? 0)) {
      return res.status(400).json({ error: 'pay_beforehand_months cannot exceed paid_months' });
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
        free_months       = IF(?, ?, free_months),
        paid_months       = IF(?, ?, paid_months),
        bonus_months      = IF(?, ?, bonus_months),
        pay_beforehand_months = IF(?, ?, pay_beforehand_months),
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
        'free_months' in req.body ? 1 : 0, durations.free_months,
        'paid_months' in req.body ? 1 : 0, durations.paid_months,
        'bonus_months' in req.body ? 1 : 0, durations.bonus_months,
        'pay_beforehand_months' in req.body ? 1 : 0, durations.pay_beforehand_months,
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
    'SELECT id, member_limit FROM membership_plans WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
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

  try {
    const insertId: number = await db.transaction(async (tx) => {
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
      return insertId;
    });

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
    const [assigned] = await attachMembershipFees(gymId, rows);
    const { rows: coveredMembers } = await db.query(MEMBERSHIP_MEMBERS_SELECT, [insertId, gymId]);
    recordAudit(req, { action: 'assign_plan', entityType: 'user_membership', entityId: insertId, next: assigned });
    res.status(201).json({ ...assigned, members: coveredMembers });
  } catch (err: any) {
    // #634 (migration 172): several Membership Plans may be active for the same
    // Member at once, so a duplicate key here means one of the selected Members
    // is already assigned *this* Plan — never "already has a membership".
    handleDupEntry(err, res, next, 'One of the selected members is already assigned this Membership Plan.');
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
          free_months, paid_months, bonus_months, pay_beforehand_months, created_by)
         VALUES (?, ?, ?, 'draft', 'staff_only', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [gymId, `${orig.name} (Copy)`, orig.description ?? null, orig.member_limit, orig.tax_rate_id, orig.tax_behavior,
         // #635: Billing & Duration is part of the plan's commercial config, so
         // a copy that dropped it would quietly differ from its original.
         orig.free_months ?? null, orig.paid_months ?? null, orig.bonus_months ?? null,
         orig.pay_beforehand_months ?? null, callerMemberId],
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
      for (const category of ['session', 'oneoff', 'periodical'] as SellableItemBenefitCategory[]) {
        const table = planBenefitTableForCategory(category);
        const { rows: benefits } = await tx.query(
          `SELECT gym_charge_id, quantity FROM ${table} WHERE membership_plan_id = ? AND gym_id = ?`,
          [req.params.id, gymId],
        );
        for (const b of benefits) {
          await tx.query(
            `INSERT INTO ${table} (gym_id, membership_plan_id, gym_charge_id, quantity, created_by_membership_id)
             VALUES (?, ?, ?, ?, ?)`,
            [gymId, insertId, b.gym_charge_id, b.quantity, callerMemberId],
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

// ─── Billing Events Forecast (#485) ────────────────────────────────────────────
// Read-only, dynamically calculated — never persisted. Reuses the same
// calculation `enrichPlan` embeds as `billing_forecast` on every Plan.

membershipPlansRouter.get('/:id/billing-forecast', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query<PlanRow>(
    'SELECT * FROM membership_plans WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [req.params.id, gymId],
  );
  if (!rows[0]) return res.status(404).json({ error: 'Plan not found' });
  const enriched = await enrichPlan(rows[0], gymId) as { billing_forecast: unknown };
  res.json(enriched.billing_forecast);
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

const ASSIGNABLE_STATUSES = ['draft', 'awaiting_payment', 'active', 'paused'];

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
// now on. A negotiated discount (an Assigned Plan with a discount_reason) keeps
// its agreed fee; only its plan-price snapshot is refreshed.
//
// #635 stage 15 — the price it pushes is the assignment's own
// `membership_fee_price`, the regular fee its snapshot owns, because the stored
// `final_price` this used to write is gone (migration 191) and a Promotion's effect
// on that fee is resolved per cycle instead. Writing a snapshot column means an
// assignment that never captured a snapshot has to capture one first
// (`materialiseAssignedPlanSnapshot`): the fallback is all-or-nothing, so setting
// this column alone would leave such an assignment reading empty benefit sections.
membershipPlansRouter.post('/:id/pricing/apply-to-assigned-plans', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  if (!(await planExists(req.params.id, gymId))) return res.status(404).json({ error: 'Plan not found' });

  const current = await loadCurrentPriceRow(db, req.params.id, gymId);
  if (!current) return res.status(400).json({ error: 'This plan has no current price to apply.' });
  const price = round2(parseFloat(current.price));
  const statusMarks = ASSIGNABLE_STATUSES.map(() => '?').join(',');

  try {
    const result = await db.transaction(async (tx) => {
      const { rows: targets } = await tx.query(
        `SELECT id, starts_at FROM user_memberships
          WHERE membership_plan_id = ? AND gym_id = ? AND status IN (${statusMarks})
            AND (discount_reason IS NULL OR discount_reason = '')`,
        [req.params.id, gymId, ...ASSIGNABLE_STATUSES],
      );
      for (const target of targets) {
        // The fee such an assignment bills *today* — its Plan's price window at its
        // own start date — so what is frozen is what it already resolves live, and
        // only the push below changes it.
        const startsAt = String(target.starts_at instanceof Date
          ? target.starts_at.toISOString().slice(0, 10)
          : target.starts_at).slice(0, 10);
        const atStart = await effectivePrice(Number(req.params.id), gymId, startsAt);
        await materialiseAssignedPlanSnapshot(tx, {
          gymId,
          userMembershipId: Number(target.id),
          membershipPlanId: Number(req.params.id),
          membershipFeePrice: atStart && atStart.plan_price_id != null ? atStart.price : null,
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
// The same three Sellable-Item-keyed sections a Promotion has had since #550,
// now on the Membership Plan itself (migration 173). Deliberately a copy of the
// Promotion contract in `promotion-details.ts` rather than a new one — the
// ticket asks for sections that "behave like the existing ... Benefits in
// Promotions", and the admin editors are shared, so the payload
// (`{ items: [{ gym_charge_id, quantity }] }`, replace-all) and every rejection
// must match what the Promotion endpoints already do.
//
// Since stage 3 (#714) these sections are what an assignment bills from, via
// the snapshot it captures at assignment time. They are also all the Plan has
// now: Charge Benefits were retired in stage 4 part 1 (migration 176) and
// Included Services in part 2 (migration 177), the latter because the relation
// it expressed belongs to the Activity Type (`activity_type_eligible_plans`)
// rather than to the Plan — see the note in that migration's header.

function selectPlanSellableItemBenefits(table: string): string {
  return `SELECT b.*, gc.name AS gym_charge_name, gc.type AS gym_charge_type,
                 gc.billing_frequency AS gym_charge_billing_frequency, gc.status AS gym_charge_status
          FROM ${table} b
          JOIN gym_charges gc ON gc.id = b.gym_charge_id
          WHERE b.membership_plan_id = ? AND b.gym_id = ?
          ORDER BY gym_charge_name ASC`;
}

const PLAN_BENEFIT_ROUTES: { path: string; category: SellableItemBenefitCategory }[] = [
  { path: 'session-benefits', category: 'session' },
  { path: 'oneoff-benefits', category: 'oneoff' },
  { path: 'periodical-benefits', category: 'periodical' },
];

for (const { path, category } of PLAN_BENEFIT_ROUTES) {
  const table = planBenefitTableForCategory(category);

  membershipPlansRouter.get(`/:id/${path}`, async (req, res, next) => {
    const { gymId } = getTenantContext(req);
    try {
      if (!(await planExists(req.params.id, gymId))) return res.status(404).json({ error: 'Plan not found' });
      const { rows } = await db.query(selectPlanSellableItemBenefits(table), [req.params.id, gymId]);
      res.json(rows);
    } catch (err) { next(err); }
  });

  membershipPlansRouter.put(`/:id/${path}`, requireRole('admin'), async (req, res, next) => {
    const { gymId } = getTenantContext(req);
    const planId = parseInt(String(req.params.id), 10);
    const { items } = req.body;
    if (!Array.isArray(items)) return res.status(400).json({ error: 'items must be an array' });
    if (!(await planExists(req.params.id, gymId))) return res.status(404).json({ error: 'Plan not found' });

    const gymChargeIds: number[] = [];
    const seen = new Set<number>();
    for (const item of items) {
      const gymChargeId = parseInt(item.gym_charge_id, 10);
      const quantity = parseInt(item.quantity, 10);
      if (!Number.isInteger(gymChargeId) || gymChargeId <= 0) {
        return res.status(400).json({ error: 'gym_charge_id is required' });
      }
      if (!Number.isInteger(quantity) || quantity <= 0) {
        return res.status(400).json({ error: 'quantity must be a positive integer' });
      }
      if (seen.has(gymChargeId)) {
        return res.status(400).json({ error: `Duplicate gym_charge_id: ${gymChargeId}` });
      }
      seen.add(gymChargeId);
      gymChargeIds.push(gymChargeId);
    }

    if (gymChargeIds.length > 0) {
      // Only *newly* selected items must be active — an item already attached to
      // this plan stays selectable after it goes inactive elsewhere, so an
      // unrelated catalog change never 400s the whole save or silently drops a
      // pre-existing selection. Same rule as the Promotion benefits and
      // Suitable Membership Plans.
      const { rows: existingAssoc } = await db.query(
        `SELECT gym_charge_id FROM ${table} WHERE membership_plan_id = ? AND gym_id = ?`,
        [planId, gymId],
      );
      const existingIds = new Set<number>(existingAssoc.map((r: any) => r.gym_charge_id));

      const placeholders = gymChargeIds.map(() => '?').join(',');
      const { rows: sellableItems } = await db.query(
        `SELECT id, type, billing_frequency, status FROM gym_charges
         WHERE gym_id = ? AND deleted_at IS NULL AND id IN (${placeholders})`,
        [gymId, ...gymChargeIds],
      );
      if (sellableItems.length !== gymChargeIds.length) {
        return res.status(400).json({ error: 'One or more Sellable Items not found in this gym' });
      }
      const newlyInactive = sellableItems.find((si: any) => si.status !== 'active' && !existingIds.has(si.id));
      if (newlyInactive) {
        return res.status(400).json({ error: `Sellable Item ${newlyInactive.id} is not active in this gym` });
      }
      const mismatched = sellableItems.find((si: any) => classifySellableItem(si) !== category);
      if (mismatched) {
        return res.status(400).json({ error: `Sellable Item ${mismatched.id} does not belong in the '${category}' category` });
      }
    }

    const callerMemberId = await getCallerMembershipId(req);
    try {
      await db.transaction(async (tx) => {
        await tx.query(`DELETE FROM ${table} WHERE membership_plan_id = ? AND gym_id = ?`, [planId, gymId]);
        for (const item of items) {
          await tx.query(
            `INSERT INTO ${table} (gym_id, membership_plan_id, gym_charge_id, quantity, created_by_membership_id)
             VALUES (?, ?, ?, ?, ?)`,
            [gymId, planId, parseInt(item.gym_charge_id, 10), parseInt(item.quantity, 10), callerMemberId],
          );
        }
      });
      recordAudit(req, { action: 'update', entityType: 'membership_plan', entityId: planId, next: { [`${category}_benefits`]: items } });
      const { rows } = await db.query(selectPlanSellableItemBenefits(table), [planId, gymId]);
      res.json(rows);
    } catch (err) { next(err); }
  });
}
