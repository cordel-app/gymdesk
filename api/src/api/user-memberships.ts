import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole, requireModuleWrite } from '../infra/tenantContext';
import { parseQuery, z } from '../infra/validate';
import { recordStatusChange, sourceForRole } from './billing-events';
import { recordAudit } from '../infra/audit';
import { handleDupEntry } from '../infra/db-helpers';
import {
  applyPromotionToMembership,
  fetchAppliedPromotions,
  fetchLiveBenefits,
  validatePromotionSelection,
} from './membership-promotions';
import { loadAssignedPlanServices } from './user-membership-services';
import { loadAssignedPlanSnapshot, snapshotAssignedPlan } from './assigned-plan-snapshot';
import {
  AppliedPromotionForBilling,
  BillingUnit,
  MembershipFeeBenefit,
  PromotionApplicationWindow,
  projectDraftBillingEvents,
  selectPersistedBillingEventsInRange,
} from '../domain/assignedPlanBillingEvents';

// #511 (stage 1 — Assigned Plans lifecycle): 'draft' and 'awaiting_payment' are
// new, pre-activation statuses. The ticket's "Closed" action maps onto the
// existing 'cancelled' value rather than introducing a new terminal status.
const STATUSES = ['draft', 'awaiting_payment', 'active', 'paused', 'cancelled', 'expired'] as const;
type Status = (typeof STATUSES)[number];

// #511 §10 — the allowed status transitions, enforced by both PUT /:id (when
// `status` is set directly) and the dedicated /submit, /close, /pause and
// /reactivate actions below. 'expired' has no forward transitions here: it's
// only ever reached by assign-new-plan's supersede logic, never by request.
const ALLOWED_TRANSITIONS: Record<Status, readonly Status[]> = {
  draft: ['awaiting_payment', 'cancelled'],
  awaiting_payment: ['active', 'cancelled'],
  active: ['paused', 'cancelled'],
  paused: ['active', 'cancelled'],
  cancelled: [],
  expired: [],
};

// Lifecycle statuses (#410) — the date-aware projection computed in LIST_SELECT below,
// as opposed to STATUSES which is the raw stored `status` column.
const LIFECYCLE_STATUSES = ['draft', 'awaiting_payment', 'pending', 'active', 'paused', 'expired', 'cancelled'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Accepts repeated `lifecycle_status=a&lifecycle_status=b` or a single comma-separated value.
const lifecycleStatusParam = z.preprocess((v) => {
  if (v === undefined) return undefined;
  const arr = Array.isArray(v) ? v : [v];
  return arr.flatMap((s) => String(s).split(',').map((x) => x.trim())).filter(Boolean);
}, z.array(z.enum(LIFECYCLE_STATUSES)).optional());

export const userMembershipsRouter = Router();

// List joined to member + plan for display (rows returned by SELECT * plus display names).
//
// lifecycle_status (#410) is a read-only, date-aware projection of the stored
// `status` column for reporting/display — it never overrides `status` in the
// database or in the business logic elsewhere in this file. A future start
// date reads as 'pending' and a past end date on an otherwise-active row
// reads as 'expired', without requiring a cron job to flip `status` itself.
export const LIST_SELECT = `
  SELECT um.*,
         m.name AS member_name,
         m.email AS member_email,
         m.nif_nie_passport AS member_nif_nie_passport,
         p.name AS plan_name,
         p.member_limit AS plan_member_limit,
         CASE
           WHEN um.status IN ('draft', 'awaiting_payment', 'paused', 'cancelled', 'expired') THEN um.status
           WHEN um.starts_at > CURDATE() THEN 'pending'
           WHEN um.ends_at IS NOT NULL AND um.ends_at < CURDATE() THEN 'expired'
           ELSE 'active'
         END AS lifecycle_status
  FROM user_memberships um
  JOIN members m ON m.id = um.member_id
  LEFT JOIN membership_plans p ON p.id = um.membership_plan_id
`;
// Note: um.* already includes next_billing_date and last_billed_at (added in migration 111).

// '1' | '2' -> that many covered Members; 'family' -> unlimited (#374).
function memberLimitCount(limit: string | null | undefined): number {
  if (limit === 'family') return Infinity;
  return parseInt(limit ?? '1', 10);
}

// Filters (#411 — Assigned Plans advanced filtering):
//   - status: raw stored `status` column (unchanged, backward-compatible single value).
//   - lifecycle_status: the computed lifecycle_status column, multi-select (includes 'pending',
//     which has no equivalent in the raw `status` column — hence the separate param).
//   - member_id: unchanged.
//   - start_date/end_date: date-range overlap against starts_at/ends_at.
//   - nif_nie_passport (#516): partial, case-insensitive text search against the related
//     Member's identification document — never validated, never converted to a number
//     (preserves leading zeros / alphanumeric passports), mirroring the #515 members.ts filter.
userMembershipsRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const q = parseQuery(req, res, z.object({
    status: z.enum(STATUSES).optional(),
    lifecycle_status: lifecycleStatusParam,
    member_id: z.coerce.number().int().positive().optional(),
    start_date: z.string().regex(DATE_RE, 'start_date must be YYYY-MM-DD').optional(),
    end_date: z.string().regex(DATE_RE, 'end_date must be YYYY-MM-DD').optional(),
    nif_nie_passport: z.string().trim().min(1).optional(),
  }));
  if (!q) return;

  const params: any[] = [gymId];
  let inner = `${LIST_SELECT} WHERE um.gym_id = ?`;
  if (q.status) { inner += ' AND um.status = ?'; params.push(q.status); }
  if (q.member_id !== undefined) { inner += ' AND um.member_id = ?'; params.push(q.member_id); }
  if (q.start_date) { inner += ' AND (um.ends_at IS NULL OR um.ends_at >= ?)'; params.push(q.start_date); }
  if (q.end_date) { inner += ' AND um.starts_at <= ?'; params.push(q.end_date); }
  if (q.nif_nie_passport) { inner += ' AND m.nif_nie_passport LIKE ?'; params.push(`%${q.nif_nie_passport}%`); }

  // lifecycle_status is a SELECT-list alias (a CASE expression), so it's filtered via an
  // outer query over a derived table rather than reusing it directly in the inner WHERE.
  let sql = `SELECT * FROM (${inner}) ap`;
  if (q.lifecycle_status && q.lifecycle_status.length > 0) {
    sql += ` WHERE ap.lifecycle_status IN (${q.lifecycle_status.map(() => '?').join(',')})`;
    params.push(...q.lifecycle_status);
  }
  sql += ' ORDER BY ap.starts_at DESC';

  const { rows } = await db.query(sql, params);
  res.json(rows);
});

// #511 (stage 2 — Assigned Plan Details modal): `created_by`/`modified_by`
// are derived from audit_logs rather than stored on user_memberships itself,
// mirroring the existing promotions.ts / themes.ts `:id` pattern. "Modified"
// means the latest action of any kind after creation — edit, submit, close,
// pause, reactivate, apply/revoke promotion, add/remove member — never just
// 'update', per the ticket's requirement that it reflect the last change
// regardless of which action produced it. Deliberately not added to
// LIST_SELECT/the expanded card: the ticket requires this audit metadata be
// shown only in the Details modal, so it's queried just for this single-row
// read instead of costing every list row a correlated subquery.
// 'assign_new_plan' is the alternate creation entry point (#412 — supersede
// a member's current plan) alongside plain 'create'; both count as this
// row's creation, never as a later "modification" of it.
const CREATION_ACTIONS = ['create', 'assign_new_plan'];

async function loadAuditMetadata(gymId: string, userMembershipId: string | number) {
  const [{ rows: createdRows }, { rows: modifiedRows }] = await Promise.all([
    db.query(
      `SELECT actor_name, created_at FROM audit_logs
       WHERE gym_id = ? AND entity_type = 'user_membership' AND entity_id = ? AND action IN (?, ?)
       ORDER BY created_at ASC LIMIT 1`,
      [gymId, String(userMembershipId), ...CREATION_ACTIONS],
    ),
    db.query(
      `SELECT actor_name, created_at FROM audit_logs
       WHERE gym_id = ? AND entity_type = 'user_membership' AND entity_id = ? AND action NOT IN (?, ?)
       ORDER BY created_at DESC LIMIT 1`,
      [gymId, String(userMembershipId), ...CREATION_ACTIONS],
    ),
  ]);
  return {
    created_by_name: createdRows[0]?.actor_name ?? null,
    modified_by_name: modifiedRows[0]?.actor_name ?? null,
    modified_at: modifiedRows[0]?.created_at ?? null,
  };
}

// ─── Expanded detail + Billing Events (#511 stage 3) ──────────────────────────
// GET /:id below embeds everything the expanded card / Details modal needs in
// one call (members, billing config, benefit usage, applied promotions, the
// Billing Events view) — mirroring `enrichPlan()` in membership-plans.ts,
// this codebase's existing pattern for an "expanded card" endpoint, rather
// than the Members-page pattern of several separate per-section requests.
// GET /:id/promotions (membership-promotions.ts) and GET /:id/billing-events
// (below) stay mounted too, both now backed by the same helpers, for callers
// that only need one section (e.g. a lighter refetch after apply/revoke).

// mysql2 may return DATE/DATETIME columns as Date objects rather than
// strings depending on the connection's timezone config (see the identical
// note in membership-plans.ts's enrichPlan) — normalize to YYYY-MM-DD before
// any string date comparison in the Billing Events range calculation.
function toDateOnly(v: unknown): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}

async function loadBillingPolicy(gymId: string, planId: number | null) {
  if (!planId) return null;
  const { rows } = await db.query(
    'SELECT * FROM billing_policies WHERE membership_plan_id = ? AND gym_id = ?',
    [planId, gymId],
  );
  return rows[0] ?? null;
}

// #635 stage 4: the assignment-time snapshot of Plan Charge Benefits
// (migration 130) is gone with the concept itself (migration 176). What an
// assignment bills is its own #635 snapshot — `loadAssignedPlanSnapshot` below.

// #635 stage 4: Included Services (`plan_allowances`) is retired with the
// concept itself (migration 177), so an assignment no longer reports activity
// allowances or their per-window usage. Which activities its Members may book
// is the Activity Type's own eligible-plan list (`activity-eligibility.ts`),
// and what the assignment *bills* is its own snapshot — `loadAssignedPlanSnapshot`.

// Every promotion ever applied to this plan (applied or revoked), with just
// the Membership Fee charge/period benefits the Billing Events range
// calculation needs — from the #511-stage-2 snapshot when present, falling
// back to a live join for pre-migration-149 rows (mirrors withSnapshot's
// fallback in membership-promotions.ts).
//
// #629: also returns the promotion's identity and Free/Paid/Bonus duration,
// which the Billing Simulation needs to classify each projected charge into a
// promotional period. Those come from the snapshot too when it has them;
// `pay_beforehand_months` (migration 141) was never snapshotted, so it is
// always read live.
export interface PromotionApplication extends AppliedPromotionForBilling {
  id: number;
  promotionId: number;
  status: string;
  name: string | null;
  freeMonths: number;
  paidMonths: number;
  bonusMonths: number;
  payBeforehandMonths: number;
}

export async function loadPromotionApplications(
  gymId: string, umId: number,
): Promise<PromotionApplication[]> {
  const { rows } = await db.query(
    `SELECT ump.id, ump.promotion_id, ump.status, ump.applied_at, ump.revoked_at, ump.snapshot,
            p.name AS promotion_name, p.free_months, p.paid_months, p.bonus_months, p.pay_beforehand_months
     FROM user_membership_promotions ump
     LEFT JOIN promotions p ON p.id = ump.promotion_id
     WHERE ump.user_membership_id = ? AND ump.gym_id = ?`,
    [umId, gymId],
  );
  return Promise.all(rows.map(async (row: any) => {
    const snap = row.snapshot as {
      name?: string; free_months?: number | null; paid_months?: number | null; bonus_months?: number | null;
      charge_benefits: any[]; period_benefits: any[];
    } | null;
    const live = snap ? null : await fetchLiveBenefits(db, row.promotion_id);
    const chargeBenefits = snap?.charge_benefits ?? live!.charge_benefits;
    const periodBenefits = snap?.period_benefits ?? live!.period_benefits;
    const membershipFeeBenefits: MembershipFeeBenefit[] = [
      ...chargeBenefits
        .filter((b) => b.charge_type_code === 'membership_fee')
        .map((b): MembershipFeeBenefit => ({ kind: 'charge', action: b.action, value: b.value })),
      ...periodBenefits
        .filter((b) => b.charge_type_code === 'membership_fee')
        .map((b): MembershipFeeBenefit => ({
          kind: 'period', action: b.action, value: b.value,
          enabled: !!b.enabled, durationMonths: b.duration_months ?? null,
        })),
    ];
    const num = (v: unknown) => Math.max(0, Math.trunc(Number(v)) || 0);
    return {
      id: row.id as number,
      promotionId: row.promotion_id as number,
      status: row.status as string,
      name: (snap?.name as string | undefined) ?? row.promotion_name ?? null,
      freeMonths: num(snap?.free_months ?? row.free_months),
      paidMonths: num(snap?.paid_months ?? row.paid_months),
      bonusMonths: num(snap?.bonus_months ?? row.bonus_months),
      payBeforehandMonths: num(row.pay_beforehand_months),
      appliedAt: toDateOnly(row.applied_at),
      revokedAt: row.revoked_at != null ? toDateOnly(row.revoked_at) : null,
      membershipFeeBenefits,
    };
  }));
}

// The Billing Events view (#511 Q2) for one Assigned Plan — see
// domain/assignedPlanBillingEvents.ts for the range rules. `draft` plans
// never write to billing_events, so their view is a pure projection from the
// plan's billing cadence + currently-applied promotions; every other status
// queries the real, persisted ledger and only ever tags/filters it.
async function computeBillingEventsView(gymId: string, um: {
  id: number; membership_plan_id: number | null; status: string;
  base_price: string | number | null; starts_at: unknown; ends_at: unknown;
  recurring_billing_interval?: number | null; recurring_billing_unit?: string | null;
}) {
  const billingStart = toDateOnly(um.starts_at);
  const endsAt = um.ends_at != null ? toDateOnly(um.ends_at) : null;
  const applications = await loadPromotionApplications(gymId, um.id);
  const windows: PromotionApplicationWindow[] = applications.map((p) => ({ appliedAt: p.appliedAt, revokedAt: p.revokedAt }));

  if (um.status === 'draft') {
    // #635 stage 3 — the cadence frozen onto the assignment decides its
    // projection; the Plan's live policy is only the fallback for an
    // assignment that captured none (§13: editing the Plan's billing
    // frequency must not move an assignment that already exists).
    const billingPolicy = um.recurring_billing_interval != null
      ? null
      : await loadBillingPolicy(gymId, um.membership_plan_id);
    return projectDraftBillingEvents({
      billingStart, endsAt,
      basePrice: Number(um.base_price ?? 0),
      recurringInterval: um.recurring_billing_interval ?? billingPolicy?.recurring_billing_interval ?? null,
      recurringUnit: (um.recurring_billing_unit ?? billingPolicy?.recurring_billing_unit ?? null) as BillingUnit | null,
      promotions: applications.filter((p) => p.status === 'applied'),
    });
  }

  const { rows: beRows } = await db.query(
    `SELECT id, event_type, charge_type_id, previous_status, new_status, source, amount, notes, created_at
     FROM billing_events WHERE gym_id = ? AND user_membership_id = ? ORDER BY created_at ASC, id ASC`,
    [gymId, um.id],
  );
  const events = beRows.map((r: any) => ({ ...r, date: toDateOnly(r.created_at) }));
  return selectPersistedBillingEventsInRange({ billingStart, endsAt, promotionWindows: windows, events });
}

userMembershipsRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(`${LIST_SELECT} WHERE um.id = ? AND um.gym_id = ?`, [req.params.id, gymId]);
  if (rows.length === 0) return res.status(404).json({ error: 'Membership not found' });
  const um = rows[0];

  const [audit, members, billingPolicy, promotions, additionalServices, snapshot] = await Promise.all([
    loadAuditMetadata(gymId, req.params.id),
    db.query(MEMBERS_SELECT, [req.params.id, gymId]).then((r) => r.rows),
    loadBillingPolicy(gymId, um.membership_plan_id),
    fetchAppliedPromotions(gymId, um.id),
    // #631 — Additional Periodic Services, embedded like every other section
    // of the expanded card. GET /:id/services stays mounted for the lighter
    // refetch the inline editor does after an add/remove.
    loadAssignedPlanServices(gymId, um.id),
    // #635 — the assignment's own frozen commercial configuration, embedded
    // like every other section of the expanded card. Since stage 3 it is also
    // what billing and the Billing Simulation read.
    loadAssignedPlanSnapshot(gymId, um.id),
  ]);
  const billingEvents = await computeBillingEventsView(gymId, um);

  res.json({
    ...um, ...audit,
    members,
    billing_policy: billingPolicy,
    promotions,
    additional_services: additionalServices,
    billing_events: billingEvents,
    snapshot,
  });
});

// A lighter, single-section fetch for callers that only need the Billing
// Events view (e.g. re-fetching just this section after applying/revoking a
// promotion, without re-fetching the whole expanded card) — computed by the
// same computeBillingEventsView() the :id response above embeds it from.
userMembershipsRouter.get('/:id/billing-events', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    `SELECT id, membership_plan_id, status, base_price, starts_at, ends_at,
            recurring_billing_interval, recurring_billing_unit
     FROM user_memberships WHERE id = ? AND gym_id = ?`,
    [req.params.id, gymId],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Membership not found' });
  res.json(await computeBillingEventsView(gymId, rows[0]));
});

// #634 §2 — only a Membership Plan that is both Active and Public may be
// assigned. The rule is enforced here, not only in the picker, because the
// ticket requires that an inactive or non-public Plan "must not be assignable
// through the API" either. `enrollment_status` is the Plan's Public/Staff-only
// column (see membership-plans.ts); `lifecycle_status` is draft/active/inactive.
//
// Returns an error payload when the Plan cannot be assigned, or null when it
// can. A Plan that does not exist (or belongs to another gym) reports 404,
// preserving the response every caller already produced for that case.
async function planAssignabilityError(gymId: string, planId: number):
  Promise<{ status: number; error: string } | null>
{
  const { rows } = await db.query(
    `SELECT lifecycle_status, enrollment_status FROM membership_plans
     WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
    [planId, gymId],
  );
  if (rows.length === 0) return { status: 404, error: 'Plan not found' };
  if (rows[0].lifecycle_status !== 'active') {
    return { status: 400, error: 'Only an active Membership Plan can be assigned' };
  }
  if (rows[0].enrollment_status !== 'public') {
    return { status: 400, error: 'Only a public Membership Plan can be assigned' };
  }
  return null;
}

// #634 §6/§14: several Membership Plans may be active for the same Member at
// once, so a duplicate key here means the *same* Plan is already assigned and
// active — never "this member already has a membership" (migration 172).
const DUPLICATE_ASSIGNMENT_ERROR = 'This member already has an active assignment of this Membership Plan.';

// Returns the price + plan_price_id that applies to `date` for a plan; falls
// back to the plan's base_price (with plan_price_id NULL) if no window matches.
export async function effectivePrice(planId: number, gymId: string, date: string):
  Promise<{ price: number; plan_price_id: number | null; base_price: number } | null>
{
  const { rows: planRows } = await db.query(
    'SELECT id FROM membership_plans WHERE id = ? AND gym_id = ?',
    [planId, gymId],
  );
  if (planRows.length === 0) return null;

  const { rows: priceRows } = await db.query(
    // #547: replacing a price on the same day leaves the superseded row with a
    // same-day closed window, so two rows can match — prefer the one that is
    // not history, then the most recent.
    `SELECT id, price FROM membership_plan_prices
     WHERE membership_plan_id = ? AND gym_id = ?
       AND valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?)
     ORDER BY (status = 'inactive') ASC, valid_from DESC, id DESC LIMIT 1`,
    [planId, gymId, date, date],
  );
  // membership_plans.base_price was dropped in migration 058 — membership_plan_prices
  // is the sole source of truth for pricing now. Fall back to 0 when no price window matches.
  const base_price = 0;
  if (priceRows.length > 0) {
    return { price: Number(priceRows[0].price), plan_price_id: priceRows[0].id, base_price };
  }
  return { price: base_price, plan_price_id: null, base_price };
}

userMembershipsRouter.post('/', requireModuleWrite('PAYMENTS'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { member_id, membership_plan_id, starts_at, ends_at, final_price, discount_reason, discount_expires_at } = req.body;
  if (!member_id || !membership_plan_id || !starts_at) {
    return res.status(400).json({ error: 'member_id, membership_plan_id and starts_at are required' });
  }

  const { rows: memberRows } = await db.query('SELECT id FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL', [member_id, gymId]);
  if (memberRows.length === 0) return res.status(404).json({ error: 'Member not found' });

  const planError = await planAssignabilityError(gymId, Number(membership_plan_id));
  if (planError) return res.status(planError.status).json({ error: planError.error });

  const eff = await effectivePrice(Number(membership_plan_id), gymId, starts_at);
  if (!eff) return res.status(404).json({ error: 'Plan not found' });

  // Snapshot: base_price + plan_price_id reference the price at signup; final_price
  // can be overridden (discount) but requires a reason.
  const finalOverride = final_price != null && final_price !== '';
  const parsedFinal = finalOverride ? parseFloat(final_price) : eff.price;
  if (finalOverride) {
    if (isNaN(parsedFinal) || parsedFinal < 0) return res.status(400).json({ error: 'final_price must be a non-negative number' });
    if (!discount_reason || !String(discount_reason).trim()) {
      return res.status(400).json({ error: 'discount_reason is required when final_price differs from the effective price' });
    }
  }

  try {
    const { userId, role } = getTenantContext(req);
    // Ledger row (P1.6): membership creation is a NULL -> active transition,
    // written in the same transaction as the insert.
    const insertId = await db.transaction(async (tx) => {
      const { insertId } = await tx.query(
        `INSERT INTO user_memberships
         (member_id, gym_id, membership_plan_id, base_price, plan_price_id, final_price,
          discount_reason, discount_expires_at, starts_at, ends_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
        [
          member_id, gymId, membership_plan_id,
          eff.base_price, eff.plan_price_id, parsedFinal,
          finalOverride ? String(discount_reason).trim() : null,
          discount_expires_at || null,
          starts_at, ends_at ?? null,
        ],
      );
      await recordStatusChange(tx, {
        gymId, userMembershipId: insertId, memberId: Number(member_id),
        previousStatus: null, newStatus: 'active',
        source: sourceForRole(role), actorUserId: userId,
      });
      // The paying Member is always the Membership's owner and its first covered Member (#374).
      await tx.query(
        'INSERT INTO user_membership_members (gym_id, user_membership_id, member_id, is_owner) VALUES (?, ?, ?, 1)',
        [gymId, insertId, member_id],
      );
      // #635 stage 2 — freeze the Plan's commercial configuration onto the
      // assignment, in the same transaction so it can never commit without one.
      await snapshotAssignedPlan(tx, {
        gymId, userMembershipId: insertId,
        membershipPlanId: Number(membership_plan_id),
        membershipFeePrice: eff.plan_price_id != null ? eff.price : null,
      });
      return insertId;
    });
    const { rows } = await db.query(`${LIST_SELECT} WHERE um.id = ?`, [insertId]);
    recordAudit(req, { action: 'create', entityType: 'user_membership', entityId: insertId, next: rows[0] });
    res.status(201).json(rows[0]);
  } catch (err: any) {
    handleDupEntry(err, res, next, DUPLICATE_ASSIGNMENT_ERROR);
  }
});

// Update lifecycle fields (dates, status, discount). Staff can pause/reactivate;
// only admin can cancel (see DELETE) but staff can flip status through 'active' or 'paused'.
userMembershipsRouter.put('/:id', requireModuleWrite('PAYMENTS'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { starts_at, ends_at, status, final_price, discount_reason, discount_expires_at } = req.body;
  if (status && !STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  }
  // Cancellations go through DELETE; guard here so staff can't cancel by PUT.
  const role = (req as any).tenantCtx?.role;
  if (status === 'cancelled' && role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can cancel a membership' });
  }
  const parsedFinal = final_price != null && final_price !== '' ? parseFloat(final_price) : null;
  if (parsedFinal !== null && (isNaN(parsedFinal) || parsedFinal < 0)) {
    return res.status(400).json({ error: 'final_price must be a non-negative number' });
  }
  try {
    const { userId } = getTenantContext(req);
    // Ledger row (P1.6): status flips emit status_changed in the same
    // transaction as the update. FOR UPDATE pins the previous status.
    const result = await db.transaction(async (tx) => {
      const { rows: current } = await tx.query(
        'SELECT id, member_id, status FROM user_memberships WHERE id = ? AND gym_id = ? FOR UPDATE',
        [req.params.id, gymId],
      );
      if (current.length === 0) return { kind: 'not_found' } as const;
      // #511 §10 — validate any direct status flip against the transition table,
      // same as the dedicated /submit, /close, /pause and /reactivate actions.
      if (status && status !== current[0].status
          && !ALLOWED_TRANSITIONS[current[0].status as Status].includes(status as Status)) {
        return { kind: 'invalid_transition', from: current[0].status } as const;
      }
      await tx.query(
        `UPDATE user_memberships SET
          starts_at            = COALESCE(?, starts_at),
          ends_at              = IF(?, ?, ends_at),
          status               = COALESCE(?, status),
          final_price          = COALESCE(?, final_price),
          discount_reason      = IF(?, ?, discount_reason),
          discount_expires_at  = IF(?, ?, discount_expires_at)
         WHERE id = ? AND gym_id = ?`,
        [
          starts_at ?? null,
          'ends_at' in req.body ? 1 : 0, ends_at ?? null,
          status ?? null,
          parsedFinal,
          'discount_reason' in req.body ? 1 : 0, discount_reason ?? null,
          'discount_expires_at' in req.body ? 1 : 0, discount_expires_at ?? null,
          req.params.id, gymId,
        ],
      );
      if (status && status !== current[0].status) {
        await recordStatusChange(tx, {
          gymId, userMembershipId: current[0].id, memberId: current[0].member_id,
          previousStatus: current[0].status, newStatus: status,
          source: sourceForRole(role), actorUserId: userId,
        });
      }
      return { kind: 'ok' } as const;
    });
    if (result.kind === 'not_found') return res.status(404).json({ error: 'Membership not found' });
    if (result.kind === 'invalid_transition') {
      return res.status(400).json({ error: `Cannot transition a membership from '${result.from}' to '${status}'` });
    }
    const { rows } = await db.query(`${LIST_SELECT} WHERE um.id = ? AND um.gym_id = ?`, [req.params.id, gymId]);
    recordAudit(req, { action: 'update', entityType: 'user_membership', entityId: req.params.id, next: rows[0] });
    res.json(rows[0]);
  } catch (err: any) {
    handleDupEntry(err, res, next, DUPLICATE_ASSIGNMENT_ERROR);
  }
});

// Cancel = admin-only status flip (soft; the row stays for history).
userMembershipsRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  const { gymId, userId, role } = getTenantContext(req);
  // Ledger row (P1.6): cancellation emits status_changed in the same transaction.
  const found = await db.transaction(async (tx) => {
    const { rows: current } = await tx.query(
      "SELECT id, member_id, status FROM user_memberships WHERE id = ? AND gym_id = ? AND status <> 'cancelled' FOR UPDATE",
      [req.params.id, gymId],
    );
    if (current.length === 0) return false;
    await tx.query(
      "UPDATE user_memberships SET status = 'cancelled' WHERE id = ? AND gym_id = ?",
      [req.params.id, gymId],
    );
    await recordStatusChange(tx, {
      gymId, userMembershipId: current[0].id, memberId: current[0].member_id,
      previousStatus: current[0].status, newStatus: 'cancelled',
      source: sourceForRole(role), actorUserId: userId,
    });
    return true;
  });
  if (!found) return res.status(404).json({ error: 'Membership not found or already cancelled' });
  recordAudit(req, { action: 'cancel', entityType: 'user_membership', entityId: req.params.id });
  res.status(204).send();
});

// #628: `promotion_ids` is optional — omitted or empty means "assign the plan
// with no promotions". Returns null when the payload isn't a list of positive
// integer ids, so the route can answer 400 instead of silently dropping it.
function parsePromotionIds(raw: unknown): number[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const ids: number[] = [];
  for (const v of raw) {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) return null;
    ids.push(n);
  }
  return ids;
}

// Assign New Plan (#412): supersede the member's current plan atomically —
// expire the old membership and create the new active one in a single
// transaction, so the one-active-membership-per-member unique index never
// sees two active rows for this member at once.
//
// #628: the caller may also pick the Promotions to apply to the new
// assignment (`promotion_ids`). They are validated as a set *before* the
// membership is created — `applyPromotionToMembership` opens its own
// transaction, so the applies can only run after this one commits, and an
// invalid selection must never leave a half-configured assignment behind.
userMembershipsRouter.post('/:id/assign-new-plan', requireRole('admin'), async (req, res, next) => {
  const { gymId, userId, role } = getTenantContext(req);
  const { membership_plan_id, starts_at, ends_at, final_price, discount_reason, discount_expires_at, promotion_ids } = req.body;
  if (!membership_plan_id || !starts_at) {
    return res.status(400).json({ error: 'membership_plan_id and starts_at are required' });
  }

  const promotionIds = parsePromotionIds(promotion_ids);
  if (promotionIds === null) {
    return res.status(400).json({ error: 'promotion_ids must be an array of promotion ids' });
  }

  const planError = await planAssignabilityError(gymId, Number(membership_plan_id));
  if (planError) return res.status(planError.status).json({ error: planError.error });

  const eff = await effectivePrice(Number(membership_plan_id), gymId, starts_at);
  if (!eff) return res.status(404).json({ error: 'Plan not found' });

  const finalOverride = final_price != null && final_price !== '';
  const parsedFinal = finalOverride ? parseFloat(final_price) : eff.price;
  if (finalOverride) {
    if (isNaN(parsedFinal) || parsedFinal < 0) return res.status(400).json({ error: 'final_price must be a non-negative number' });
    if (!discount_reason || !String(discount_reason).trim()) {
      return res.status(400).json({ error: 'discount_reason is required when final_price differs from the effective price' });
    }
  }

  // #634 §3: the "Only applicable for new members" check is about the Member,
  // not the assignment, so the superseded row is read for its owner before the
  // selection is validated. The new assignment doesn't exist yet at this point
  // — nothing is excluded from the Member's history, and the row being
  // superseded is exactly what makes a still-current member not new.
  const { rows: supersededRows } = await db.query(
    'SELECT member_id FROM user_memberships WHERE id = ? AND gym_id = ?',
    [req.params.id, gymId],
  );
  if (supersededRows.length === 0) return res.status(404).json({ error: 'Membership not found' });

  const promoError = await validatePromotionSelection(
    gymId, Number(membership_plan_id), promotionIds, Number(supersededRows[0].member_id),
  );
  if (promoError) return res.status(promoError.status).json({ error: promoError.error });

  try {
    const newId: number | null = await db.transaction(async (tx) => {
      const { rows: current } = await tx.query(
        'SELECT id, member_id, status FROM user_memberships WHERE id = ? AND gym_id = ? FOR UPDATE',
        [req.params.id, gymId],
      );
      if (current.length === 0) return null;
      const prev = current[0];

      // Only supersede a still-live plan; a row that's already cancelled/expired is left as-is.
      if (prev.status === 'active' || prev.status === 'paused') {
        await tx.query("UPDATE user_memberships SET status = 'expired' WHERE id = ? AND gym_id = ?", [prev.id, gymId]);
        await recordStatusChange(tx, {
          gymId, userMembershipId: prev.id, memberId: prev.member_id,
          previousStatus: prev.status, newStatus: 'expired',
          source: sourceForRole(role), actorUserId: userId,
        });
      }

      const { insertId } = await tx.query(
        `INSERT INTO user_memberships
         (member_id, gym_id, membership_plan_id, base_price, plan_price_id, final_price,
          discount_reason, discount_expires_at, starts_at, ends_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
        [
          prev.member_id, gymId, membership_plan_id,
          eff.base_price, eff.plan_price_id, parsedFinal,
          finalOverride ? String(discount_reason).trim() : null,
          discount_expires_at || null,
          starts_at, ends_at ?? null,
        ],
      );
      await recordStatusChange(tx, {
        gymId, userMembershipId: insertId, memberId: prev.member_id,
        previousStatus: null, newStatus: 'active',
        source: sourceForRole(role), actorUserId: userId,
      });
      await tx.query(
        'INSERT INTO user_membership_members (gym_id, user_membership_id, member_id, is_owner) VALUES (?, ?, ?, 1)',
        [gymId, insertId, prev.member_id],
      );
      // #635 stage 2 — the superseding assignment gets its own snapshot; the
      // superseded row keeps the one it was created with, untouched.
      await snapshotAssignedPlan(tx, {
        gymId, userMembershipId: insertId,
        membershipPlanId: Number(membership_plan_id),
        membershipFeePrice: eff.plan_price_id != null ? eff.price : null,
      });
      return insertId;
    });
    if (newId === null) return res.status(404).json({ error: 'Membership not found' });

    // Applied after the assignment commits, one at a time, because each apply
    // runs its own transaction (and recomputes final_price from base_price +
    // the benefits of every promotion applied so far). The selection was
    // validated above, so a failure here means the promotion changed
    // underneath us between the two steps — surface it rather than silently
    // assigning a plan without the promotions that were asked for.
    for (const promotionId of promotionIds) {
      await applyPromotionToMembership(gymId, userId, sourceForRole(role), newId, promotionId);
    }

    const { rows } = await db.query(`${LIST_SELECT} WHERE um.id = ?`, [newId]);
    recordAudit(req, {
      action: 'assign_new_plan', entityType: 'user_membership', entityId: newId,
      next: rows[0], previous: { supersedes_user_membership_id: Number(req.params.id) },
    });
    res.status(201).json({ ...rows[0], applied_promotion_ids: promotionIds });
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    handleDupEntry(err, res, next, DUPLICATE_ASSIGNMENT_ERROR);
  }
});

// ─── Lifecycle actions (#511 stage 1 — Assigned Plans status model) ───────────
// submit/pause/reactivate share the same shape: lock the row, check the
// current status against an allow-list, flip it, and record both a
// billing_events status_changed row and an audit_logs entry. Close (below) is
// bespoke — it needs an unused-value warning/confirm step and stamps
// closed_at — so it isn't folded into this helper.
async function transitionMembership(
  req: any, res: any, action: string, targetStatus: Status, allowedFrom: readonly Status[],
) {
  const { gymId, userId, role } = getTenantContext(req);
  const result = await db.transaction(async (tx) => {
    const { rows: current } = await tx.query(
      'SELECT id, member_id, status FROM user_memberships WHERE id = ? AND gym_id = ? FOR UPDATE',
      [req.params.id, gymId],
    );
    if (current.length === 0) return { kind: 'not_found' } as const;
    const prev = current[0];
    if (!allowedFrom.includes(prev.status as Status)) return { kind: 'invalid', from: prev.status } as const;
    await tx.query('UPDATE user_memberships SET status = ? WHERE id = ? AND gym_id = ?', [targetStatus, prev.id, gymId]);
    await recordStatusChange(tx, {
      gymId, userMembershipId: prev.id, memberId: prev.member_id,
      previousStatus: prev.status, newStatus: targetStatus,
      source: sourceForRole(role), actorUserId: userId,
    });
    return { kind: 'ok' } as const;
  });

  if (result.kind === 'not_found') return res.status(404).json({ error: 'Membership not found' });
  if (result.kind === 'invalid') {
    return res.status(400).json({ error: `Cannot ${action} a membership with status '${result.from}'` });
  }
  const { rows } = await db.query(`${LIST_SELECT} WHERE um.id = ? AND um.gym_id = ?`, [req.params.id, gymId]);
  recordAudit(req, { action, entityType: 'user_membership', entityId: req.params.id, next: rows[0] });
  res.json(rows[0]);
}

// Submit (#511 Q1): draft -> awaiting_payment. Persisted future Billing
// Events are materialized starting with this ticket's Billing Events stage —
// submitting today only flips the status, which has no financial effect on
// its own since nothing in the running system pre-creates future
// billing_events rows yet (billing.ts only ever charges what's due the day
// the billing run executes).
userMembershipsRouter.post('/:id/submit', requireModuleWrite('PAYMENTS'), async (req, res) => {
  await transitionMembership(req, res, 'submit', 'awaiting_payment', ['draft']);
});

userMembershipsRouter.post('/:id/pause', requireModuleWrite('PAYMENTS'), async (req, res) => {
  await transitionMembership(req, res, 'pause', 'paused', ['active']);
});

userMembershipsRouter.post('/:id/reactivate', requireModuleWrite('PAYMENTS'), async (req, res) => {
  await transitionMembership(req, res, 'reactivate', 'active', ['paused']);
});

// Close (#511 §7): admin-only, mirroring DELETE's existing cancel restriction
// (both permanently end a membership). Unlike DELETE, Close first checks for
// unused value that would be lost and requires explicit confirmation before
// proceeding (409 + `confirm: true` to resend, same contract as
// activity-type-schedule-rules.ts's confirm_cancel_booked guard), and stamps
// closed_at separately from the admin-settable `ends_at`.
const CLOSEABLE_FROM: readonly Status[] = ['awaiting_payment', 'active', 'paused'];

// #511 stage 3 also counted a `session_count` allowance with sessions left in
// its current recurrence window as unused value about to be lost. #635 stage 4
// retired Included Services (migration 177), so a pending billing event is once
// again the only kind of unused value an assignment can have — a Plan's Session
// Benefits are billed up front, not consumed per booking, so closing the
// assignment does not forfeit them.
function computeUnusedValueWarnings(
  um: { next_billing_date: unknown; has_pending_billing: number | boolean },
): string[] {
  const warnings: string[] = [];
  if (Number(um.has_pending_billing) === 1) {
    warnings.push(`1 pending billing event on ${um.next_billing_date}`);
  }
  return warnings;
}

userMembershipsRouter.post('/:id/close', requireRole('admin'), async (req, res) => {
  const { gymId, userId, role } = getTenantContext(req);
  const confirm = req.body?.confirm === true;

  const { rows: currentRows } = await db.query(
    `SELECT id, status, membership_plan_id, next_billing_date,
            (next_billing_date IS NOT NULL AND next_billing_date >= CURDATE()) AS has_pending_billing
     FROM user_memberships WHERE id = ? AND gym_id = ?`,
    [req.params.id, gymId],
  );
  if (currentRows.length === 0) return res.status(404).json({ error: 'Membership not found' });
  const current = currentRows[0];
  if (!CLOSEABLE_FROM.includes(current.status)) {
    return res.status(400).json({ error: `Cannot close a membership with status '${current.status}'` });
  }

  const warnings = computeUnusedValueWarnings(current);
  if (warnings.length > 0 && !confirm) {
    return res.status(409).json({
      error: 'unused_value_impacted',
      message: `Closing this Assigned Plan will remove access to: ${warnings.join(', ')}. Resend with confirm: true to proceed.`,
      warnings,
    });
  }

  const result = await db.transaction(async (tx) => {
    const { rows: locked } = await tx.query(
      'SELECT id, member_id, status FROM user_memberships WHERE id = ? AND gym_id = ? FOR UPDATE',
      [req.params.id, gymId],
    );
    if (locked.length === 0) return { kind: 'not_found' } as const;
    const prev = locked[0];
    if (!CLOSEABLE_FROM.includes(prev.status as Status)) return { kind: 'invalid', from: prev.status } as const;
    await tx.query(
      "UPDATE user_memberships SET status = 'cancelled', closed_at = UTC_TIMESTAMP() WHERE id = ? AND gym_id = ?",
      [prev.id, gymId],
    );
    await recordStatusChange(tx, {
      gymId, userMembershipId: prev.id, memberId: prev.member_id,
      previousStatus: prev.status, newStatus: 'cancelled',
      source: sourceForRole(role), actorUserId: userId,
    });
    return { kind: 'ok' } as const;
  });

  if (result.kind === 'not_found') return res.status(404).json({ error: 'Membership not found' });
  if (result.kind === 'invalid') {
    return res.status(400).json({ error: `Cannot close a membership with status '${result.from}'` });
  }
  const { rows } = await db.query(`${LIST_SELECT} WHERE um.id = ? AND um.gym_id = ?`, [req.params.id, gymId]);
  recordAudit(req, { action: 'close', entityType: 'user_membership', entityId: req.params.id, next: rows[0] });
  res.json(rows[0]);
});

// ─── Covered Members (#374 — multi-member Membership Plans) ───────────────────
// A Membership's covered Members receive the plan's benefits/entitlements
// alongside its owner. The owner (inserted on POST /) can never be removed;
// additional Members are capped by the plan's member_limit ('1' | '2' | 'family').

export const MEMBERS_SELECT = `
  SELECT umm.member_id, umm.is_owner, m.name, m.email
  FROM user_membership_members umm
  JOIN members m ON m.id = umm.member_id
  WHERE umm.user_membership_id = ? AND umm.gym_id = ?
  ORDER BY umm.is_owner DESC, m.name ASC
`;

async function findMembershipWithPlanLimit(id: string | string[], gymId: string) {
  const { rows } = await db.query(
    `SELECT um.id, p.member_limit FROM user_memberships um
     LEFT JOIN membership_plans p ON p.id = um.membership_plan_id
     WHERE um.id = ? AND um.gym_id = ?`,
    [id, gymId],
  );
  return rows[0] ?? null;
}

userMembershipsRouter.get('/:id/members', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const membership = await findMembershipWithPlanLimit(req.params.id, gymId);
  if (!membership) return res.status(404).json({ error: 'Membership not found' });
  const { rows } = await db.query(MEMBERS_SELECT, [req.params.id, gymId]);
  res.json({ member_limit: membership.member_limit ?? '1', members: rows });
});

userMembershipsRouter.post('/:id/members', requireModuleWrite('PAYMENTS'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { member_id } = req.body;
  if (!member_id) return res.status(400).json({ error: 'member_id is required' });

  const membership = await findMembershipWithPlanLimit(req.params.id, gymId);
  if (!membership) return res.status(404).json({ error: 'Membership not found' });

  const { rows: memberRows } = await db.query(
    'SELECT id FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [member_id, gymId],
  );
  if (memberRows.length === 0) return res.status(404).json({ error: 'Member not found' });

  const { rows: countRows } = await db.query(
    'SELECT COUNT(*) AS n FROM user_membership_members WHERE user_membership_id = ? AND gym_id = ?',
    [req.params.id, gymId],
  );
  if (Number(countRows[0].n) >= memberLimitCount(membership.member_limit)) {
    return res.status(400).json({ error: 'This membership has reached its member limit.' });
  }

  try {
    await db.query(
      'INSERT INTO user_membership_members (gym_id, user_membership_id, member_id, is_owner) VALUES (?, ?, ?, 0)',
      [gymId, req.params.id, member_id],
    );
    const { rows } = await db.query(MEMBERS_SELECT, [req.params.id, gymId]);
    recordAudit(req, { action: 'add_member', entityType: 'user_membership', entityId: req.params.id, next: { member_id } });
    res.status(201).json(rows);
  } catch (err: any) {
    handleDupEntry(err, res, next, 'This Member is already covered by this Membership.');
  }
});

userMembershipsRouter.delete('/:id/members/:memberId', requireModuleWrite('PAYMENTS'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    'SELECT is_owner FROM user_membership_members WHERE user_membership_id = ? AND member_id = ? AND gym_id = ?',
    [req.params.id, req.params.memberId, gymId],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'This Member is not covered by this Membership.' });
  if (rows[0].is_owner) return res.status(400).json({ error: 'Cannot remove the Membership owner.' });
  await db.query(
    'DELETE FROM user_membership_members WHERE user_membership_id = ? AND member_id = ? AND gym_id = ?',
    [req.params.id, req.params.memberId, gymId],
  );
  recordAudit(req, { action: 'remove_member', entityType: 'user_membership', entityId: req.params.id, previous: { member_id: req.params.memberId } });
  res.status(204).send();
});
