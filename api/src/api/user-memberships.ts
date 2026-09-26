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
  membershipFeeBenefitsFromSnapshot,
  validatePromotionSelection,
} from './membership-promotions';
import { loadAssignedPlanServices } from './user-membership-services';
import { currentMembershipFee, currentMembershipFees } from './membership-fee-pricing';
import {
  loadAssignedPlanBenefitSection,
  loadAssignedPlanSnapshot,
  materialiseAssignedPlanSnapshot,
  snapshotAssignedPlan,
  writeAssignedPlanBenefitSection,
} from './assigned-plan-snapshot';
import {
  SellableItemBenefitCategory,
  classifySellableItem,
} from '../domain/sellableItemClassification';
import {
  AppliedPromotionForBilling,
  BillingUnit,
  MembershipFeeBenefit,
  PromotionApplicationWindow,
  projectDraftBillingEvents,
  selectPersistedBillingEventsInRange,
} from '../domain/assignedPlanBillingEvents';
import {
  NO_PERSONAL_FEE_BENEFIT,
  PERSONAL_FEE_BENEFIT_ACTIONS,
  PersonalFeeBenefit,
  PersonalFeeBenefitAction,
  isPersonalFeeBenefitAction,
  toPersonalFeeBenefit,
} from '../domain/personalFeeBenefit';
import { NO_PLAN_DURATION, PlanDuration, toPlanDuration } from '../domain/planDuration';

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

/**
 * One assignment as every write endpoint answers with it: its row plus
 * `membership_fee` — the fee resolved for the cycle it is next charged for
 * (#635 stage 15). The row itself carries only `membership_fee_price`, the
 * *regular* fee an edit writes; what it actually pays depends on the date, so it
 * cannot be a column.
 */
async function loadAssignmentRow(gymId: string, id: string | string[] | number, scoped = true) {
  const { rows } = scoped
    ? await db.query(`${LIST_SELECT} WHERE um.id = ? AND um.gym_id = ?`, [id, gymId])
    : await db.query(`${LIST_SELECT} WHERE um.id = ?`, [id]);
  if (rows.length === 0) return null;
  return { ...rows[0], membership_fee: await currentMembershipFee(gymId, Number(rows[0].id)) };
}

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
  // #635 stage 15 — `membership_fee` is what each assignment pays for the cycle
  // it is next charged for, resolved through the one rule the nightly run uses.
  // It replaces the stored `final_price` this list used to return: a number with
  // no date in it could not say that a cycle is inside a Free Period, or that an
  // applied Promotion's discount has already ended.
  const fees = await currentMembershipFees(gymId, rows.map((r: any) => Number(r.id)));
  res.json(rows.map((r: any) => ({ ...r, membership_fee: fees.get(Number(r.id)) ?? null })));
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
  return (await loadPromotionApplicationsFor(gymId, [umId])).get(umId) ?? [];
}

/**
 * The same, for many assignments in one query. Every list that prices a
 * Membership Fee per row needs each row's standing applications, and one query
 * per row turns an Assigned Plans page into hundreds of round trips.
 */
export async function loadPromotionApplicationsFor(
  gymId: string, umIds: number[],
): Promise<Map<number, PromotionApplication[]>> {
  const byAssignment = new Map<number, PromotionApplication[]>();
  const ids = [...new Set(umIds)];
  if (ids.length === 0) return byAssignment;
  const { rows } = await db.query(
    `SELECT ump.id, ump.user_membership_id, ump.promotion_id, ump.status,
            ump.applied_at, ump.revoked_at, ump.snapshot,
            p.name AS promotion_name, p.free_months, p.paid_months, p.bonus_months, p.pay_beforehand_months
     FROM user_membership_promotions ump
     LEFT JOIN promotions p ON p.id = ump.promotion_id
     WHERE ump.user_membership_id IN (${ids.map(() => '?').join(',')}) AND ump.gym_id = ?`,
    [...ids, gymId],
  );
  const shaped = await Promise.all(rows.map(async (row: any) => {
    const snap = row.snapshot as {
      name?: string; free_months?: number | null; paid_months?: number | null; bonus_months?: number | null;
    } | null;
    // #635 stage 5: the snapshot owns the benefit; only an application from
    // before migration 149 (snapshot IS NULL) still reads the Promotion's
    // current definition. `membershipFeeBenefitsFromSnapshot` also understands
    // the pre-stage-5 snapshot shape, so history keeps pricing as it did.
    const benefits = snap
      ? membershipFeeBenefitsFromSnapshot(snap)
      : (await fetchLiveBenefits(db, row.promotion_id)).membership_fee_benefits;
    const membershipFeeBenefits: MembershipFeeBenefit[] = benefits.map((b): MembershipFeeBenefit => ({
      action: (b.action ?? null) as MembershipFeeBenefit['action'],
      value: b.value ?? null,
      enabled: !!b.enabled,
      durationMonths: b.duration_months ?? null,
    }));
    const num = (v: unknown) => Math.max(0, Math.trunc(Number(v)) || 0);
    return {
      userMembershipId: Number(row.user_membership_id),
      application: {
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
      } as PromotionApplication,
    };
  }));
  for (const { userMembershipId, application } of shaped) {
    const list = byAssignment.get(userMembershipId) ?? [];
    list.push(application);
    byAssignment.set(userMembershipId, list);
  }
  return byAssignment;
}

/**
 * #635 stage 12 — the assignment's own regular fee and Billing & Duration, for
 * the draft Billing Events projection.
 *
 * Read here rather than taken from the caller's row so both entry points (the
 * expanded card and `GET /:id/billing-events`) resolve identically. The
 * all-or-nothing snapshot rule is the same one `billing-simulation.ts` and the
 * nightly run apply: an assignment that captured anything reads its own columns,
 * NULLs included, so a Free Period added to the Plan later cannot reach it (§13).
 *
 * The price comes from `regularMembershipFee()` — the same chain the Billing
 * Simulation and the nightly run resolve — never from `base_price`: that column is
 * snapshotted from `effectivePrice()`, which has returned a constant 0 since
 * migration 058 dropped `membership_plans.base_price`, so a projection built on it
 * shows a column of zeros for every assignment created through the API.
 */
async function loadAssignmentFeeContext(gymId: string, umId: number): Promise<{
  regularFee: number | null; planDuration: PlanDuration; personalFeeBenefit: PersonalFeeBenefit;
}> {
  const { rows } = await db.query(
    `SELECT um.membership_plan_id, um.membership_fee_price,
            um.base_price, um.starts_at,
            um.free_months, um.paid_months, um.bonus_months, um.pay_beforehand_months,
            um.personal_fee_benefit_action, um.personal_fee_benefit_value,
            p.free_months AS plan_free_months,
            p.paid_months AS plan_paid_months,
            p.bonus_months AS plan_bonus_months,
            p.pay_beforehand_months AS plan_pay_beforehand_months,
            (um.free_months IS NOT NULL OR um.paid_months IS NOT NULL OR um.pay_beforehand_months IS NOT NULL
             OR um.bonus_months IS NOT NULL OR um.recurring_billing_interval IS NOT NULL
             OR um.recurring_billing_unit IS NOT NULL OR um.membership_fee_price IS NOT NULL
            ) AS has_billing_snapshot
     FROM user_memberships um
     LEFT JOIN membership_plans p ON p.id = um.membership_plan_id
     WHERE um.id = ? AND um.gym_id = ?`,
    [umId, gymId],
  );
  const um = rows[0];
  if (!um) {
    return { regularFee: null, planDuration: NO_PLAN_DURATION, personalFeeBenefit: NO_PERSONAL_FEE_BENEFIT };
  }
  return {
    regularFee: await regularMembershipFee(gymId, um, toDateOnly(um.starts_at)),
    planDuration: Number(um.has_billing_snapshot) === 1
      ? toPlanDuration(um.free_months, um.paid_months, um.bonus_months, um.pay_beforehand_months)
      : toPlanDuration(um.plan_free_months, um.plan_paid_months, um.plan_bonus_months, um.plan_pay_beforehand_months),
    personalFeeBenefit: toPersonalFeeBenefit(um.personal_fee_benefit_action, um.personal_fee_benefit_value),
  };
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
    // #635 stage 12 — the assignment's own regular fee and Billing & Duration, so
    // this projection prices each cycle exactly as the Billing Simulation, My
    // Membership and the nightly run do.
    const fee = await loadAssignmentFeeContext(gymId, um.id);
    return projectDraftBillingEvents({
      billingStart, endsAt,
      basePrice: fee.regularFee ?? Number(um.base_price ?? 0),
      recurringInterval: um.recurring_billing_interval ?? billingPolicy?.recurring_billing_interval ?? null,
      recurringUnit: (um.recurring_billing_unit ?? billingPolicy?.recurring_billing_unit ?? null) as BillingUnit | null,
      promotions: applications.filter((p) => p.status === 'applied'),
      assignment: {
        startsAt: billingStart,
        planDuration: fee.planDuration,
        personalFeeBenefit: fee.personalFeeBenefit,
      },
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
  const membershipFee = await currentMembershipFee(gymId, Number(um.id));

  res.json({
    ...um, ...audit,
    // The fee resolved for this assignment's current cycle (#635 stage 15) —
    // the read-only counterpart of `snapshot.membership_fee_price`, which is the
    // regular fee it is priced from and the one an edit writes.
    membership_fee: membershipFee,
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

/**
 * The regular (pre-Promotion) Membership Fee an assignment bills: the price
 * frozen onto it at assignment time (#635 stage 3), falling back to its Plan's
 * price window covering its start date only when it has none.
 *
 * `user_memberships.base_price` is not usable as *the* regular price — it is
 * snapshotted from `effectivePrice()`, which has returned a constant 0 for that
 * field since `membership_plans.base_price` was dropped in migration 058 — but a
 * row that does carry a non-zero one (written before that, or by a fixture) is
 * still saying what the fee was before any Promotion, so it is read before giving
 * up. `null` means this assignment has no fee anyone can name.
 *
 * `ignoreFrozenFee` skips the frozen number and resolves the Plan's price window
 * instead. Its one caller is a **negotiated fee that has lapsed** (a
 * `discount_reason` with a past `discount_expires_at`, see
 * `membership-fee-pricing.ts`): the frozen column carries that agreement, so
 * while it holds it outranks the catalogue, and when it stops the catalogue is
 * what the assignment falls back to. The frozen fee is still the last resort —
 * an assignment whose Plan has no price window has nothing better to bill.
 *
 * One function since #635 stage 12, because it decides the number every path
 * discounts *from*: the Billing Simulation, the Billing Events projection, the
 * nightly run and every screen that shows what a member pays. Two copies of this
 * chain would reintroduce exactly the drift stage 12 exists to remove.
 */
export async function regularMembershipFee(
  gymId: string,
  row: {
    membership_plan_id: number | null;
    membership_fee_price: string | number | null;
    base_price?: string | number | null;
  },
  startsAt: string,
  opts?: { ignoreFrozenFee?: boolean },
): Promise<number | null> {
  const frozen = row.membership_fee_price != null ? Number(row.membership_fee_price) : null;
  if (frozen != null && !opts?.ignoreFrozenFee) return frozen;
  if (row.membership_plan_id != null) {
    const eff = await effectivePrice(row.membership_plan_id, gymId, startsAt);
    if (eff && eff.plan_price_id != null) return eff.price;
  }
  if (row.base_price != null && Number(row.base_price) > 0) return Number(row.base_price);
  return frozen;
}

userMembershipsRouter.post('/', requireModuleWrite('PAYMENTS'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { member_id, membership_plan_id, starts_at, ends_at, membership_fee_price, discount_reason, discount_expires_at } = req.body;
  if (!member_id || !membership_plan_id || !starts_at) {
    return res.status(400).json({ error: 'member_id, membership_plan_id and starts_at are required' });
  }

  const { rows: memberRows } = await db.query('SELECT id FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL', [member_id, gymId]);
  if (memberRows.length === 0) return res.status(404).json({ error: 'Member not found' });

  const planError = await planAssignabilityError(gymId, Number(membership_plan_id));
  if (planError) return res.status(planError.status).json({ error: planError.error });

  const eff = await effectivePrice(Number(membership_plan_id), gymId, starts_at);
  if (!eff) return res.status(404).json({ error: 'Plan not found' });

  // Snapshot: base_price + plan_price_id reference the price at signup, and the
  // assignment's own Membership Fee is frozen onto it by `snapshotAssignedPlan`
  // below. #635 stage 15: a negotiated fee is a different *value of that same
  // column* — there is no second stored price any more — so it still requires a
  // reason, and it is the number every later cycle is priced from (§15).
  const feeOverride = membership_fee_price != null && membership_fee_price !== '';
  const parsedFee = feeOverride ? parseFloat(membership_fee_price) : eff.price;
  if (feeOverride) {
    if (isNaN(parsedFee) || parsedFee < 0) return res.status(400).json({ error: 'membership_fee_price must be a non-negative number' });
    if (!discount_reason || !String(discount_reason).trim()) {
      return res.status(400).json({ error: 'discount_reason is required when membership_fee_price differs from the effective price' });
    }
  }

  try {
    const { userId, role } = getTenantContext(req);
    // Ledger row (P1.6): membership creation is a NULL -> active transition,
    // written in the same transaction as the insert.
    const insertId = await db.transaction(async (tx) => {
      const { insertId } = await tx.query(
        `INSERT INTO user_memberships
         (member_id, gym_id, membership_plan_id, base_price, plan_price_id,
          discount_reason, discount_expires_at, starts_at, ends_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
        [
          member_id, gymId, membership_plan_id,
          eff.base_price, eff.plan_price_id,
          feeOverride ? String(discount_reason).trim() : null,
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
        // A negotiated fee is frozen in place of the catalogue one: it is this
        // assignment's agreed regular price, and nothing else stores it (§15).
        membershipFeePrice: feeOverride ? parsedFee : (eff.plan_price_id != null ? eff.price : null),
      });
      return insertId;
    });
    const created = await loadAssignmentRow(gymId, insertId, false);
    recordAudit(req, { action: 'create', entityType: 'user_membership', entityId: insertId, next: created });
    res.status(201).json(created);
  } catch (err: any) {
    handleDupEntry(err, res, next, DUPLICATE_ASSIGNMENT_ERROR);
  }
});

// Update lifecycle fields (dates, status, discount). Staff can pause/reactivate;
// only admin can cancel (see DELETE) but staff can flip status through 'active' or 'paused'.
userMembershipsRouter.put('/:id', requireModuleWrite('PAYMENTS'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { starts_at, ends_at, status, discount_reason, discount_expires_at } = req.body;
  if (status && !STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  }
  // Cancellations go through DELETE; guard here so staff can't cancel by PUT.
  const role = (req as any).tenantCtx?.role;
  if (status === 'cancelled' && role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can cancel a membership' });
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
          discount_reason      = IF(?, ?, discount_reason),
          discount_expires_at  = IF(?, ?, discount_expires_at)
         WHERE id = ? AND gym_id = ?`,
        [
          starts_at ?? null,
          'ends_at' in req.body ? 1 : 0, ends_at ?? null,
          status ?? null,
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
    const updated = await loadAssignmentRow(gymId, req.params.id);
    recordAudit(req, { action: 'update', entityType: 'user_membership', entityId: req.params.id, next: updated });
    res.json(updated);
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
  const { membership_plan_id, starts_at, ends_at, membership_fee_price, discount_reason, discount_expires_at, promotion_ids } = req.body;
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

  const feeOverride = membership_fee_price != null && membership_fee_price !== '';
  const parsedFee = feeOverride ? parseFloat(membership_fee_price) : eff.price;
  if (feeOverride) {
    if (isNaN(parsedFee) || parsedFee < 0) return res.status(400).json({ error: 'membership_fee_price must be a non-negative number' });
    if (!discount_reason || !String(discount_reason).trim()) {
      return res.status(400).json({ error: 'discount_reason is required when membership_fee_price differs from the effective price' });
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
         (member_id, gym_id, membership_plan_id, base_price, plan_price_id,
          discount_reason, discount_expires_at, starts_at, ends_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
        [
          prev.member_id, gymId, membership_plan_id,
          eff.base_price, eff.plan_price_id,
          feeOverride ? String(discount_reason).trim() : null,
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
      //
      // #772: the Personal Membership Fee Benefit is deliberately *not*
      // carried over either. It lasts "the entire lifetime of the Assigned
      // Membership Plan", and this is a different Assigned Plan — a new
      // contract on a new Plan, at a price that was renegotiated in this very
      // request. Copying a percentage agreed against the old Plan's fee onto
      // the new one would apply a discount nobody agreed to the new number.
      // The successor starts at the column default (no benefit); staff set one
      // on it through `PUT /:id/fee-benefit` if that is what was agreed.
      await snapshotAssignedPlan(tx, {
        gymId, userMembershipId: insertId,
        membershipPlanId: Number(membership_plan_id),
        // A negotiated fee is frozen in place of the catalogue one: it is this
        // assignment's agreed regular price, and nothing else stores it (§15).
        membershipFeePrice: feeOverride ? parsedFee : (eff.plan_price_id != null ? eff.price : null),
      });
      return insertId;
    });
    if (newId === null) return res.status(404).json({ error: 'Membership not found' });

    // Applied after the assignment commits, one at a time, because each apply
    // runs its own transaction. The selection was
    // validated above, so a failure here means the promotion changed
    // underneath us between the two steps — surface it rather than silently
    // assigning a plan without the promotions that were asked for.
    for (const promotionId of promotionIds) {
      await applyPromotionToMembership(gymId, userId, sourceForRole(role), newId, promotionId);
    }

    const created = await loadAssignmentRow(gymId, newId, false);
    recordAudit(req, {
      action: 'assign_new_plan', entityType: 'user_membership', entityId: newId,
      next: created, previous: { supersedes_user_membership_id: Number(req.params.id) },
    });
    res.status(201).json({ ...created, applied_promotion_ids: promotionIds });
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
  const moved = await loadAssignmentRow(gymId, req.params.id);
  recordAudit(req, { action, entityType: 'user_membership', entityId: req.params.id, next: moved });
  res.json(moved);
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
  const closed = await loadAssignmentRow(gymId, req.params.id);
  recordAudit(req, { action: 'close', entityType: 'user_membership', entityId: req.params.id, next: closed });
  res.json(closed);
});

// ─── The Assigned Plan's own snapshot, edited section by section (#635 stage 6) ─
//
// §9/§10/§15: the Assigned Membership Plan exposes the same structure as the
// Membership Plan it came from — Billing & Duration plus One-off / Session /
// Period Benefits — and each section is edited on its own. Editing one edits
// *this member's* snapshot: the source Plan, its other assignments and the
// Sellable Items are untouched, which is exactly what makes the ticket's
// "Assigned Plan A → €90, Assigned Plan B → €100, Membership Plan → €100"
// example hold.
//
// Since stage 3 these rows are what the assignment bills, so an edit here moves
// its Billing Simulation immediately — there is no second place to write.

// A terminal assignment is history: it bills nothing further, so rewriting the
// configuration it was agreed with would only falsify the record. Same reasoning
// as ATTACHABLE_STATUSES in user-membership-services.ts.
const SNAPSHOT_EDITABLE_STATUSES: readonly Status[] = ['draft', 'awaiting_payment', 'active', 'paused'];

const BILLING_UNITS = ['day', 'week', 'month', 'year'] as const;

/**
 * The assignment as the snapshot editors need it, or null when it isn't this
 * gym's. Read before the transaction so the Plan's price window can be resolved
 * (`effectivePrice` runs its own queries) for an assignment that still has to
 * capture a snapshot; the row is re-read and locked inside the transaction.
 */
async function loadAssignmentForSnapshotEdit(gymId: string, id: string | string[]) {
  const { rows } = await db.query(
    `SELECT id, membership_plan_id, status, starts_at,
            free_months, paid_months, bonus_months, pay_beforehand_months,
            recurring_billing_interval, recurring_billing_unit, membership_fee_price
     FROM user_memberships WHERE id = ? AND gym_id = ?`,
    [id, gymId],
  );
  return rows[0] ?? null;
}

/**
 * The regular fee to freeze when an assignment that never captured a snapshot
 * is about to be edited — the price window covering its start date, which is
 * what `regularMembershipFee()` resolves live for it today. Null when the Plan
 * has no price window (nothing to freeze) or the assignment has no Plan.
 */
export async function snapshotFeeForAssignment(gymId: string, um: any): Promise<number | null> {
  if (um.membership_plan_id == null) return null;
  const eff = await effectivePrice(Number(um.membership_plan_id), gymId, toDateOnly(um.starts_at));
  return eff && eff.plan_price_id != null ? eff.price : null;
}

/** `null` when the value is absent/blank, a number when parseable, NaN otherwise. */
function optionalNumber(raw: unknown): number | null | typeof NaN {
  if (raw === null || raw === undefined || raw === '') return null;
  return Number(raw);
}

/** Rejects a half-set cadence from inside the transaction, so nothing commits. */
class CadencePairError extends Error {}

/**
 * Rejects a Pre-paid Duration longer than the Paid Duration it is a slice of
 * (#635 stage 13 — the Promotion's own 0..paid_months bound,
 * `validatePayBeforehandMonths`). Thrown from inside the transaction for the
 * same reason as the cadence pair: the snapshot `materialiseAssignedPlanSnapshot`
 * may just have captured must roll back with the rejected edit.
 */
class PrepaidBoundError extends Error {}

function nonNegativeInteger(raw: unknown): number | null | false {
  const n = optionalNumber(raw);
  if (n === null) return null;
  if (!Number.isInteger(n) || n < 0) return false;
  return n;
}

userMembershipsRouter.put('/:id/billing-duration', requireModuleWrite('PAYMENTS'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const um = await loadAssignmentForSnapshotEdit(gymId, req.params.id);
  if (!um) return res.status(404).json({ error: 'Membership not found' });
  if (!SNAPSHOT_EDITABLE_STATUSES.includes(um.status as Status)) {
    return res.status(400).json({ error: `Cannot edit the configuration of a membership with status '${um.status}'` });
  }

  // Only the fields the caller sent are written, so a section's editor can save
  // Billing & Duration without having to resend the cadence it doesn't show.
  const patch: Record<string, number | string | null> = {};
  for (const field of ['free_months', 'paid_months', 'bonus_months', 'pay_beforehand_months', 'recurring_billing_interval'] as const) {
    if (!(field in req.body)) continue;
    const value = nonNegativeInteger(req.body[field]);
    if (value === false) return res.status(400).json({ error: `${field} must be a non-negative integer` });
    if (field === 'recurring_billing_interval' && value === 0) {
      return res.status(400).json({ error: 'recurring_billing_interval must be a positive integer' });
    }
    patch[field] = value;
  }
  if ('recurring_billing_unit' in req.body) {
    const raw = req.body.recurring_billing_unit;
    const unit = raw === null || raw === undefined || raw === '' ? null : String(raw);
    if (unit !== null && !BILLING_UNITS.includes(unit as any)) {
      return res.status(400).json({ error: `recurring_billing_unit must be one of: ${BILLING_UNITS.join(', ')}` });
    }
    patch.recurring_billing_unit = unit;
  }
  if ('membership_fee_price' in req.body) {
    const price = optionalNumber(req.body.membership_fee_price);
    if (price !== null && (isNaN(price) || price < 0)) {
      return res.status(400).json({ error: 'membership_fee_price must be a non-negative number' });
    }
    patch.membership_fee_price = price;
  }
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'No Billing & Duration fields to update' });

  const feeToFreeze = await snapshotFeeForAssignment(gymId, um);
  try {
    const result = await db.transaction(async (tx) => {
      const { rows: locked } = await tx.query(
        'SELECT id, status FROM user_memberships WHERE id = ? AND gym_id = ? FOR UPDATE',
        [req.params.id, gymId],
      );
      if (locked.length === 0) return { kind: 'not_found' } as const;
      if (!SNAPSHOT_EDITABLE_STATUSES.includes(locked[0].status as Status)) {
        return { kind: 'not_editable', status: locked[0].status as string } as const;
      }
      await materialiseAssignedPlanSnapshot(tx, {
        gymId, userMembershipId: Number(um.id),
        membershipPlanId: um.membership_plan_id != null ? Number(um.membership_plan_id) : null,
        membershipFeePrice: feeToFreeze,
      });

      // The cadence is read as a pair (ASSIGNMENT_CADENCE COALESCEs each column
      // on its own), so half of one would mix the assignment's interval with
      // the Plan's unit and silently bill on a cadence nobody configured.
      // Checked against the row as it now stands — an assignment that only just
      // captured its snapshot above already has the Plan's cadence on it, so
      // sending one half of the pair is valid for it.
      const { rows: current } = await tx.query(
        `SELECT recurring_billing_interval, recurring_billing_unit, paid_months, pay_beforehand_months
         FROM user_memberships WHERE id = ? AND gym_id = ?`,
        [req.params.id, gymId],
      );
      const nextInterval = 'recurring_billing_interval' in patch
        ? patch.recurring_billing_interval : current[0].recurring_billing_interval;
      const nextUnit = 'recurring_billing_unit' in patch
        ? patch.recurring_billing_unit : current[0].recurring_billing_unit;
      // Thrown rather than returned: the materialise above must roll back with
      // the rejected edit, so a 400 leaves the assignment exactly as it was.
      if ((nextInterval == null) !== (nextUnit == null)) throw new CadencePairError();

      // The Pre-paid Duration is a slice of the Paid Duration, so it is checked
      // against the row as it will stand — sending only one of the two is valid,
      // and either one alone can break the bound.
      const nextPaid = 'paid_months' in patch ? patch.paid_months : current[0].paid_months;
      const nextPrepaid = 'pay_beforehand_months' in patch
        ? patch.pay_beforehand_months : current[0].pay_beforehand_months;
      if (nextPrepaid != null && Number(nextPrepaid) > Number(nextPaid ?? 0)) throw new PrepaidBoundError();

      const assignments = Object.keys(patch).map((c) => `${c} = ?`).join(', ');
      await tx.query(
        `UPDATE user_memberships SET ${assignments} WHERE id = ? AND gym_id = ?`,
        [...Object.values(patch), req.params.id, gymId],
      );
      return { kind: 'ok' } as const;
    });
    if (result.kind === 'not_found') return res.status(404).json({ error: 'Membership not found' });
    if (result.kind === 'not_editable') {
      return res.status(400).json({ error: `Cannot edit the configuration of a membership with status '${result.status}'` });
    }

    recordAudit(req, {
      action: 'update', entityType: 'user_membership', entityId: req.params.id,
      previous: {
        free_months: um.free_months, paid_months: um.paid_months, bonus_months: um.bonus_months,
        pay_beforehand_months: um.pay_beforehand_months,
        recurring_billing_interval: um.recurring_billing_interval,
        recurring_billing_unit: um.recurring_billing_unit,
        membership_fee_price: um.membership_fee_price,
      },
      next: { billing_duration: patch },
    });
    res.json(await loadAssignedPlanSnapshot(gymId, Number(um.id)));
  } catch (err) {
    if (err instanceof CadencePairError) {
      return res.status(400).json({ error: 'recurring_billing_interval and recurring_billing_unit must be set together' });
    }
    if (err instanceof PrepaidBoundError) {
      return res.status(400).json({ error: 'pay_beforehand_months cannot exceed paid_months' });
    }
    next(err);
  }
});

/**
 * #772 — the Assigned Plan's own **Personal Membership Fee Benefit**.
 *
 * `{ action: 'no_benefit' | 'percentage_discount', value: number | null }`,
 * replace-all: the assignment holds one such benefit or none, so there is
 * nothing to merge and the payload is the whole configuration.
 *
 * Three things make it unlike the Billing & Duration route above.
 *
 * It is **not part of the snapshot**, so `materialiseAssignedPlanSnapshot()`
 * is deliberately not called: the snapshot is what was captured from the
 * catalogue, its fallback is all-or-nothing, and these columns have no
 * catalogue counterpart to fall back *to* — every row already carries an
 * answer. Materialising here would freeze an unrelated assignment's durations
 * as a side effect of giving its member a discount.
 *
 * It **never expires** — there is no `discount_expires_at` beside it and no
 * Promotion window around it, which is the whole point of the ticket: the
 * benefit "remains active for the entire lifetime of the Assigned Membership
 * Plan, unless the Assigned Membership Plan is explicitly edited".
 *
 * And it is **not a negotiated price**: `membership_fee_price` is still the
 * regular fee this contract discounts *from*, so a staff-agreed number and a
 * personal percentage remain two separate decisions and the percentage keeps
 * following the fee if the fee is later renegotiated.
 *
 * A terminal assignment is read-only for the same reason every other section
 * is: it bills nothing further, so changing what it was agreed with would only
 * falsify the record.
 */
userMembershipsRouter.put('/:id/fee-benefit', requireModuleWrite('PAYMENTS'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const um = await loadAssignmentForSnapshotEdit(gymId, req.params.id);
  if (!um) return res.status(404).json({ error: 'Membership not found' });
  if (!SNAPSHOT_EDITABLE_STATUSES.includes(um.status as Status)) {
    return res.status(400).json({ error: `Cannot edit the configuration of a membership with status '${um.status}'` });
  }

  const rawAction = req.body?.action;
  if (!isPersonalFeeBenefitAction(rawAction)) {
    return res.status(400).json({ error: `action must be one of: ${PERSONAL_FEE_BENEFIT_ACTIONS.join(', ')}` });
  }
  const action: PersonalFeeBenefitAction = rawAction;

  let value: number | null = null;
  if (action === 'percentage_discount') {
    const raw = optionalNumber(req.body?.value);
    if (raw === null || !Number.isFinite(raw) || raw < 0 || raw > 100) {
      return res.status(400).json({ error: 'value must be a percentage between 0 and 100' });
    }
    value = Math.round(raw * 100) / 100;
  }

  try {
    const result = await db.transaction(async (tx) => {
      // Re-read under the row lock: the status may have moved to a terminal one
      // between the check above and here, and the previous values are what the
      // audit entry records.
      const { rows: locked } = await tx.query(
        `SELECT id, status, personal_fee_benefit_action, personal_fee_benefit_value
         FROM user_memberships WHERE id = ? AND gym_id = ? FOR UPDATE`,
        [req.params.id, gymId],
      );
      if (locked.length === 0) return { kind: 'not_found' } as const;
      if (!SNAPSHOT_EDITABLE_STATUSES.includes(locked[0].status as Status)) {
        return { kind: 'not_editable', status: locked[0].status as string } as const;
      }
      await tx.query(
        `UPDATE user_memberships
            SET personal_fee_benefit_action = ?, personal_fee_benefit_value = ?
          WHERE id = ? AND gym_id = ?`,
        [action, value, req.params.id, gymId],
      );
      return { kind: 'ok', previous: locked[0] } as const;
    });
    if (result.kind === 'not_found') return res.status(404).json({ error: 'Membership not found' });
    if (result.kind === 'not_editable') {
      return res.status(400).json({ error: `Cannot edit the configuration of a membership with status '${result.status}'` });
    }

    recordAudit(req, {
      action: 'update', entityType: 'user_membership', entityId: req.params.id,
      previous: {
        personal_fee_benefit_action: result.previous.personal_fee_benefit_action,
        personal_fee_benefit_value: result.previous.personal_fee_benefit_value,
      },
      next: { personal_fee_benefit: { action, value } },
    });
    res.json(await loadAssignedPlanSnapshot(gymId, Number(um.id)));
  } catch (err) {
    next(err);
  }
});

// One route per benefit kind, with the replace-all `{ items: [{ gym_charge_id,
// quantity }] }` payload the Plan and Promotion sections already take — the
// admin editors are shared, so the contract has to be the same one. What
// differs is what a row means: on a Plan it points at the live Sellable Item,
// here it *is* the agreed line, so the write freezes the item's commercial
// facts (`writeAssignedPlanBenefitSection`).
const ASSIGNED_BENEFIT_ROUTES: { path: string; category: SellableItemBenefitCategory }[] = [
  { path: 'session-benefits', category: 'session' },
  { path: 'oneoff-benefits', category: 'oneoff' },
  { path: 'periodical-benefits', category: 'periodical' },
];

for (const { path, category } of ASSIGNED_BENEFIT_ROUTES) {
  userMembershipsRouter.get(`/:id/${path}`, async (req, res, next) => {
    const { gymId } = getTenantContext(req);
    try {
      const um = await loadAssignmentForSnapshotEdit(gymId, req.params.id);
      if (!um) return res.status(404).json({ error: 'Membership not found' });
      res.json(await loadAssignedPlanBenefitSection(gymId, Number(um.id), category));
    } catch (err) { next(err); }
  });

  userMembershipsRouter.put(`/:id/${path}`, requireModuleWrite('PAYMENTS'), async (req, res, next) => {
    const { gymId } = getTenantContext(req);
    const { items } = req.body;
    if (!Array.isArray(items)) return res.status(400).json({ error: 'items must be an array' });

    const um = await loadAssignmentForSnapshotEdit(gymId, req.params.id);
    if (!um) return res.status(404).json({ error: 'Membership not found' });
    if (!SNAPSHOT_EDITABLE_STATUSES.includes(um.status as Status)) {
      return res.status(400).json({ error: `Cannot edit the configuration of a membership with status '${um.status}'` });
    }

    const parsed: { gym_charge_id: number; quantity: number }[] = [];
    const seen = new Set<number>();
    for (const item of items) {
      const gymChargeId = parseInt(item?.gym_charge_id, 10);
      const quantity = parseInt(item?.quantity, 10);
      if (!Number.isInteger(gymChargeId) || gymChargeId <= 0) {
        return res.status(400).json({ error: 'gym_charge_id is required' });
      }
      if (!Number.isInteger(quantity) || quantity <= 0) {
        return res.status(400).json({ error: 'quantity must be a positive integer' });
      }
      if (seen.has(gymChargeId)) return res.status(400).json({ error: `Duplicate gym_charge_id: ${gymChargeId}` });
      seen.add(gymChargeId);
      parsed.push({ gym_charge_id: gymChargeId, quantity });
    }

    // A line already in this section is part of what was agreed, so it stays
    // saveable whatever has since happened to the Sellable Item — retired,
    // deactivated or reclassified. Only a *newly* added item is held to the
    // catalogue's current state, and to the section's own category.
    const current = await loadAssignedPlanBenefitSection(gymId, Number(um.id), category);
    const alreadyAttached = new Set(current.map((row) => row.gym_charge_id));
    const added = parsed.filter((item) => !alreadyAttached.has(item.gym_charge_id)).map((i) => i.gym_charge_id);
    if (added.length > 0) {
      const marks = added.map(() => '?').join(',');
      const { rows: sellableItems } = await db.query(
        `SELECT id, type, billing_frequency, status FROM gym_charges
         WHERE gym_id = ? AND deleted_at IS NULL AND id IN (${marks})`,
        [gymId, ...added],
      );
      if (sellableItems.length !== added.length) {
        return res.status(400).json({ error: 'One or more Sellable Items not found in this gym' });
      }
      const inactive = sellableItems.find((si: any) => si.status !== 'active');
      if (inactive) {
        return res.status(400).json({ error: `Sellable Item ${inactive.id} is not active in this gym` });
      }
      const mismatched = sellableItems.find((si: any) => classifySellableItem(si) !== category);
      if (mismatched) {
        return res.status(400).json({ error: `Sellable Item ${mismatched.id} does not belong in the '${category}' category` });
      }
    }

    const feeToFreeze = await snapshotFeeForAssignment(gymId, um);
    try {
      const applied = await db.transaction(async (tx) => {
        // Re-checked under the lock: the status may have moved between the
        // read above and this write.
        const { rows: locked } = await tx.query(
          'SELECT id, status FROM user_memberships WHERE id = ? AND gym_id = ? FOR UPDATE',
          [req.params.id, gymId],
        );
        if (locked.length === 0) return { kind: 'not_found' } as const;
        if (!SNAPSHOT_EDITABLE_STATUSES.includes(locked[0].status as Status)) {
          return { kind: 'not_editable', status: locked[0].status as string } as const;
        }
        // Captures what this assignment resolves live today *before* the edit,
        // so replacing one section can't blank the other two for an assignment
        // that predates the snapshot (stage 3's fallback is all-or-nothing).
        await materialiseAssignedPlanSnapshot(tx, {
          gymId, userMembershipId: Number(um.id),
          membershipPlanId: um.membership_plan_id != null ? Number(um.membership_plan_id) : null,
          membershipFeePrice: feeToFreeze,
        });
        await writeAssignedPlanBenefitSection(tx, {
          gymId, userMembershipId: Number(um.id), category, items: parsed,
        });
        return { kind: 'ok' } as const;
      });
      if (applied.kind === 'not_found') return res.status(404).json({ error: 'Membership not found' });
      if (applied.kind === 'not_editable') {
        return res.status(400).json({ error: `Cannot edit the configuration of a membership with status '${applied.status}'` });
      }

      recordAudit(req, {
        action: 'update', entityType: 'user_membership', entityId: req.params.id,
        previous: { [`${category}_benefits`]: current.map((r) => ({ gym_charge_id: r.gym_charge_id, quantity: r.quantity })) },
        next: { [`${category}_benefits`]: parsed },
      });
      res.json(await loadAssignedPlanBenefitSection(gymId, Number(um.id), category));
    } catch (err) { next(err); }
  });
}

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
