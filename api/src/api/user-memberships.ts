import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole, requireModuleWrite } from '../infra/tenantContext';
import { parseQuery, z } from '../infra/validate';
import { recordStatusChange, sourceForRole } from './billing-events';
import { recordAudit } from '../infra/audit';
import { handleDupEntry } from '../infra/db-helpers';
import { rollStaleNextBillingDateForward } from '../domain/nextBillingDateStamp';
import { actorSnapshot } from '../domain/nutritionLibrary';
import {
  applyPromotionToMembership,
  fetchAppliedPromotions,
  fetchLiveBenefits,
  membershipFeeBenefitsFromSnapshot,
  validatePromotionSelection,
} from './membership-promotions';
import { loadAssignedPlanServices } from './user-membership-services';
import {
  currentCycleDate,
  currentMembershipFee,
  currentMembershipFees,
  loadFeeAssignment,
  priceMembershipFeeOn,
} from './membership-fee-pricing';
import { assignedPlanFeeTimeline, assignedPlanFeeTimelineById } from './assigned-plan-fee-timeline';
import { assignedPlanBillingForecast } from './assigned-plan-billing-forecast';
import {
  loadAssignedPlanBenefitSection,
  loadAssignedPlanSnapshot,
  materialiseAssignedPlanSnapshot,
  snapshotAssignedPlan,
  writeAssignedPlanBenefitSection,
} from './assigned-plan-snapshot';
import {
  ProductBenefitCategory,
  classifyProduct,
} from '../domain/productClassification';
import {
  AppliedPromotionForBilling,
  MembershipFeeBenefit,
  PromotionApplicationWindow,
  selectPersistedBillingEventsInRange,
} from '../domain/assignedPlanBillingEvents';
import {
  PERSONAL_FEE_BENEFIT_ACTIONS,
  PersonalFeeBenefitAction,
  isPersonalFeeBenefitAction,
} from '../domain/personalFeeBenefit';
import {
  LiveAssignment,
  activePlanConflictBody,
} from '../domain/oneActivePlan';
import {
  findLiveAssignmentsForMembers,
  membershipPlanName,
} from './one-active-plan';
import { CommitOutcome, PENDING_PAYMENT_STATUS, SubmitOutcome, commitAssignment, submitForPayment } from './assignment-commit';

// #1108 stage 1 — an assignment is created `draft` and becomes `active` through
// one explicit commit. #511 stage 1 had added two pre-activation statuses,
// `draft` and `awaiting_payment`, which nothing ever wrote or read, so #786
// retired both (migration 198 narrowed the CHECK back) and recorded that a
// payment gate before activation would be "a schema widening and a ticket of
// its own". #1108 is that ticket; migration 227 is that widening, and it brings
// back `draft` alone — Pending Payment is stage 2's, arriving with the Save &
// Pay transaction that produces it rather than as a second value nothing can
// write. The ticket's "Closed" action still maps onto the existing 'cancelled'
// value rather than introducing a new terminal status.
const STATUSES = ['draft', 'pending_payment', 'active', 'paused', 'cancelled', 'expired'] as const;
type Status = (typeof STATUSES)[number];

// #511 §10 — the allowed status transitions, enforced by both PUT /:id (when
// `status` is set directly) and the dedicated /close, /pause and
// /reactivate actions below. 'expired' has no forward transitions here: it's
// only ever reached by assign-new-plan's supersede logic, never by request.
//
// #1108: `draft` has exactly two, and neither is reachable through `PUT /:id`.
// `draft -> active` is the commit — it has to run #956's one-plan check and
// supersede whatever it replaces, so it lives in `POST /:id/activate` and the
// PUT refuses it the way cancellation is refused and routed to DELETE. A Draft
// is cancelled through that same DELETE. There is no `draft -> paused`: pausing
// something that has never been active says nothing.
//
// #1108 stage 2: `pending_payment` sits between the two. `draft -> pending_payment`
// is Save & Pay (`POST /:id/save-and-pay`) and `pending_payment -> active` is
// the payment's confirmation (the webhook, or `POST /:id/record-payment`); a
// `PUT` reaches neither, for the reason above. A pending row is cancelled
// through DELETE / close, as a Draft is.
const ALLOWED_TRANSITIONS: Record<Status, readonly Status[]> = {
  draft: ['pending_payment', 'active', 'cancelled'],
  pending_payment: ['active', 'cancelled'],
  active: ['paused', 'cancelled'],
  paused: ['active', 'cancelled'],
  cancelled: [],
  expired: [],
};

/**
 * The status every assignment path creates a row in (#1108 §1). A constant
 * rather than a literal in three INSERTs, so "a newly assigned plan is a Draft"
 * is one answer: `POST /`, `POST /:id/assign-new-plan` and
 * `POST /membership-plans/:id/assign` all write it, and stage 2's Save & Pay is
 * what moves a row out of it.
 */
export const ASSIGNMENT_CREATION_STATUS = 'draft';

// Lifecycle statuses (#410) — the date-aware projection computed in LIST_SELECT below,
// as opposed to STATUSES which is the raw stored `status` column.
const LIFECYCLE_STATUSES = ['draft', 'pending_payment', 'pending', 'active', 'paused', 'expired', 'cancelled'] as const;
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
/**
 * The `lifecycle_status` projection itself, so the one place that decides it is
 * this constant rather than a CASE expression copied into a second query.
 *
 * #1051 gave it a second reader: the Member card shows its Assigned Plans with
 * the Assigned Plans page's own table, and a Status column that read the stored
 * `status` on one screen and this projection on the other would label the same
 * future-dated assignment `Active` here and `Pending` there. It takes `um` as
 * its table alias, which both callers already use.
 */
export const LIFECYCLE_STATUS_SQL = `
  CASE
    WHEN um.status IN ('draft', 'pending_payment', 'paused', 'cancelled', 'expired') THEN um.status
    WHEN um.starts_at > CURDATE() THEN 'pending'
    WHEN um.ends_at IS NOT NULL AND um.ends_at < CURDATE() THEN 'expired'
    ELSE 'active'
  END`;

export const LIST_SELECT = `
  SELECT um.*,
         m.name AS member_name,
         m.email AS member_email,
         m.nif_nie_passport AS member_nif_nie_passport,
         p.name AS plan_name,
         p.member_limit AS plan_member_limit,
         ${LIFECYCLE_STATUS_SQL} AS lifecycle_status
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

// #511 (stage 2 — Assigned Plan Details modal): "modified" means the latest
// action of any kind after creation — edit, close, pause, reactivate,
// apply/revoke promotion, add/remove member — never just 'update', per the
// ticket's requirement that it reflect the last change regardless of which
// action produced it. It stays derived from `audit_logs` and stays out of
// LIST_SELECT, because an assignment is also modified by things that are not
// people: the nightly run advancing `next_billing_date`, the payment webhook
// stamping the first one, the dunning escalation pausing it. None of those has
// an actor to snapshot, and the audit log records them with their own `source`.
//
// There is one creation action per insert path, and all three are excluded
// here: 'create' (POST /), 'assign_new_plan' (#412 — supersede a member's
// current plan) and 'assign_plan' (the Plans page's bulk assign, written by
// membership-plans.ts). Each counts as a row's creation, never as a later
// "modification" of it — 'assign_plan' was missing from this list until #958,
// which made a bulk-assigned plan report its creator as the last person to
// modify it, since the creation row was then the newest row not excluded.
//
// #958: `created_by` is **not** read from here any more. The Member's
// MEMBERSHIP PLANS section shows it on every card, and one correlated subquery
// per row is exactly what #511 declined to pay — so the creation actor is
// snapshotted onto the row by the three paths that insert one (migration 215,
// backfilled from these same audit rows) and read as the plain column it is.
const CREATION_ACTIONS = ['create', 'assign_new_plan', 'assign_plan'];

async function loadAuditMetadata(gymId: string, userMembershipId: string | number) {
  const { rows: modifiedRows } = await db.query(
    `SELECT actor_name, created_at FROM audit_logs
     WHERE gym_id = ? AND entity_type = 'user_membership' AND entity_id = ?
       AND action NOT IN (${CREATION_ACTIONS.map(() => '?').join(',')})
     ORDER BY created_at DESC LIMIT 1`,
    [gymId, String(userMembershipId), ...CREATION_ACTIONS],
  );
  return {
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

// The Billing Events view (#511 Q2) for one Assigned Plan — see
// domain/assignedPlanBillingEvents.ts for the range rules. It queries the real,
// persisted ledger and only ever tags/filters it. #511 also projected a view for
// a `draft` assignment, which had no ledger yet; #786 retired that status, so
// every assignment reads its ledger.
async function computeBillingEventsView(gymId: string, um: {
  id: number; membership_plan_id: number | null; status: string;
  base_price: string | number | null; starts_at: unknown; ends_at: unknown;
  recurring_billing_interval?: number | null; recurring_billing_unit?: string | null;
}) {
  const billingStart = toDateOnly(um.starts_at);
  const endsAt = um.ends_at != null ? toDateOnly(um.ends_at) : null;
  const applications = await loadPromotionApplications(gymId, um.id);
  const windows: PromotionApplicationWindow[] = applications.map((p) => ({ appliedAt: p.appliedAt, revokedAt: p.revokedAt }));

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
  // One pricing row for both answers: what this cycle costs, and what every
  // cycle from here on will (#924 stage 3). Loading it twice is two queries for
  // one question.
  const feeRow = await loadFeeAssignment(gymId, Number(um.id));
  const membershipFee = feeRow ? (await priceMembershipFeeOn(feeRow, currentCycleDate(feeRow))).amount : null;
  const exampleTimeline = feeRow ? await assignedPlanFeeTimeline(gymId, feeRow) : null;
  // #924 stage 4 (§8) — the Billing Event Forecast: every line this assignment
  // still has ahead of it, grouped by the date it falls on. Read through the
  // very loader the Member-level Billing Simulation uses, so it cannot price a
  // date differently from the nightly run.
  const billingEventSimulation = await assignedPlanBillingForecast(gymId, Number(um.id));

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
    // #924 stage 3 (§7) — the Membership Fee Simulation: the Membership Plan
    // card's Example Timeline for this contract, priced by the same
    // `resolveMembershipFee()` the nightly run charges with. Read-only,
    // computed on every read, persisted nowhere (see docs/architecture.md).
    example_timeline: exampleTimeline,
    // #924 stage 4 (§8/§9/§10) — the Billing Event Forecast: one group per
    // billing *date*, listing every line that falls on it (the Membership Fee
    // plus each Product and Additional Periodic Service this contract
    // carries), where the Membership Fee Simulation above is one row per
    // billing *period* about the fee alone. Neither replaces the other.
    // Read-only, computed on every read, persisted nowhere.
    billing_event_simulation: billingEventSimulation,
    snapshot,
  });
});

// The same projection on its own, for a caller that only needs this section —
// the card refetches it after a configuration or promotion edit, exactly as it
// does the Billing Events view above. `GET /membership-plans/:id/example-timeline`
// is its Membership Plan counterpart (#818).
userMembershipsRouter.get('/:id/example-timeline', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    const timeline = await assignedPlanFeeTimelineById(gymId, Number(req.params.id));
    if (!timeline) return res.status(404).json({ error: 'Membership not found' });
    res.json(timeline);
  } catch (err) { next(err); }
});

// The same projection on its own, for the refetch the card does after a
// configuration or promotion edit — `GET /membership-plans/:id/billing-event-simulation`
// is its Membership Plan counterpart (#915) and
// `GET /promotions/:id/billing-event-simulation` the Promotion's (#922).
userMembershipsRouter.get('/:id/billing-event-simulation', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    const { rows } = await db.query(
      'SELECT id FROM user_memberships WHERE id = ? AND gym_id = ?', [req.params.id, gymId],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Membership not found' });
    res.json(await assignedPlanBillingForecast(gymId, Number(req.params.id)));
  } catch (err) { next(err); }
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

// #956 (migration 213): a Member holds at most one live Membership Plan, so a
// duplicate key on `user_memberships_one_active` means a second active row was
// inserted for the same Member concurrently — the application check below found
// nothing to lock, and the index is what serialises that case. #634's
// "several plans in parallel, but only one of each type" (migration 172) is
// reversed, so this message no longer names the Plan.
const DUPLICATE_ASSIGNMENT_ERROR = 'This member already has an active Membership Plan.';

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
    const { userId, role, actorName, isSuperadmin } = getTenantContext(req);
    // #958 — the creation actor, snapshotted onto the row (migration 215) so
    // the Member's plan cards can show *Created by* without a per-row audit
    // subquery. One of the three paths that insert a `user_memberships` row.
    const actor = actorSnapshot({ name: actorName, isSuperadmin });
    // #1108 stage 1: the assignment is created as a **Draft**, which is not the
    // Member's Membership Plan (Q2). So #956's one-plan check does not run here
    // any more — a Draft replacement has to be configurable *beside* the plan it
    // replaces — and it runs on the `draft -> active` commit instead
    // (`POST /:id/activate`), which is where the supersede and the `confirm`
    // live now. A Draft row's `active_member_key` is NULL (migration 213's
    // generated column), so the UNIQUE index cannot collide either.
    //
    // Ledger row (P1.6): membership creation is a NULL -> draft transition,
    // written in the same transaction as the insert.
    const outcome = await db.transaction(async (tx) => {
      const { insertId } = await tx.query(
        `INSERT INTO user_memberships
         (member_id, gym_id, membership_plan_id, base_price, plan_price_id,
          discount_reason, discount_expires_at, starts_at, ends_at, status,
          created_by_name, created_by_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          member_id, gymId, membership_plan_id,
          eff.base_price, eff.plan_price_id,
          feeOverride ? String(discount_reason).trim() : null,
          discount_expires_at || null,
          starts_at, ends_at ?? null,
          ASSIGNMENT_CREATION_STATUS,
          // #958 — who assigned the plan, snapshotted in the same INSERT
          // (migration 215). The Member's MEMBERSHIP PLANS section shows it on
          // every card, which is why it is a column rather than an audit read.
          actor.name, actor.type,
        ],
      );
      await recordStatusChange(tx, {
        gymId, userMembershipId: insertId, memberId: Number(member_id),
        previousStatus: null, newStatus: ASSIGNMENT_CREATION_STATUS,
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
      return { kind: 'created' as const, insertId };
    });
    const created = await loadAssignmentRow(gymId, outcome.insertId, false);
    recordAudit(req, {
      action: 'create', entityType: 'user_membership', entityId: outcome.insertId, next: created,
    });
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
  // #1108: committing a Draft goes through POST /:id/activate for the same
  // reason cancellation goes through DELETE — that transition runs #956's
  // one-plan check and supersedes whatever it replaces, and a plain `status`
  // flip here would activate a second live plan for the member with no
  // confirmation and no cancellation of the first.
  if (status === 'active') {
    const { rows: pre } = await db.query<{ status: string }>(
      'SELECT status FROM user_memberships WHERE id = ? AND gym_id = ?',
      [req.params.id, gymId],
    );
    if (pre[0]?.status === 'draft') {
      return res.status(400).json({
        error: 'A Draft membership is activated through POST /user-memberships/:id/activate, '
          + 'which replaces the member\'s current plan.',
      });
    }
    // #1108 stage 2: a Pending Payment row becomes active when its payment is
    // confirmed — the webhook, or POST /:id/record-payment — never by hand.
    if (pre[0]?.status === PENDING_PAYMENT_STATUS) {
      return res.status(400).json({
        error: 'A membership pending payment is activated by its payment: the hosted checkout, '
          + 'or POST /user-memberships/:id/record-payment for a cash payment.',
      });
    }
  }
  if (status === PENDING_PAYMENT_STATUS) {
    return res.status(400).json({
      error: 'A Draft moves to pending payment through POST /user-memberships/:id/save-and-pay.',
    });
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
      // same as the dedicated /close, /pause and /reactivate actions.
      if (status && status !== current[0].status
          && !ALLOWED_TRANSITIONS[current[0].status as Status].includes(status as Status)) {
        return { kind: 'invalid_transition', from: current[0].status } as const;
      }
      // #785: a direct flip to `active` clears the nightly run's dunning state
      // for the same reason `/reactivate` does — the resumed assignment gets the
      // documented two attempts, not one. Nothing else on this route touches the
      // pair, which is run state and not an editable field.
      const resetDunning = status === 'active' && current[0].status !== 'active'
        ? ', failed_attempts = 0, last_failed_at = NULL'
        : '';
      await tx.query(
        `UPDATE user_memberships SET
          starts_at            = COALESCE(?, starts_at),
          ends_at              = IF(?, ?, ends_at),
          status               = COALESCE(?, status),
          discount_reason      = IF(?, ?, discount_reason),
          discount_expires_at  = IF(?, ?, discount_expires_at)${resetDunning}
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
      // #790: a pause is not a debt — a `next_billing_date` that went by while
      // the assignment was off the run moves to the first boundary after today.
      if (resetDunning) {
        await rollStaleNextBillingDateForward(tx, current[0].id, gymId);
      }
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

/**
 * Commit a Draft assignment: `draft -> active` (#1108 stage 1).
 *
 * This is the one place that transition lives, and it is a route of its own
 * rather than a `status` flip on `PUT /:id` because committing a Draft is the
 * moment #956's rule is enforced: the Member may have been holding another plan
 * all along while this one was configured (Q2 — a Draft is deliberately outside
 * `LIVE_ASSIGNMENT_STATUSES`), so activation is what finds that plan, locks it,
 * and either answers the 409 the replacement dialog is drawn from or supersedes
 * it. A plain `PUT` would leave the member with two live plans, no confirmation
 * and no cancellation of the first; the PUT therefore refuses it and names this
 * route, exactly as it refuses a cancellation and names DELETE.
 *
 * Stage 2's **Save & Pay** is the second caller of this commit rather than a
 * second commit: it raises the payment, moves the row through Pending Payment
 * and consolidates the forecast into real Billing Events around the very same
 * transition. Until it exists this is how a configured Draft becomes the
 * member's plan, which is also what keeps assignment working between the two
 * stages.
 *
 * The supersede date is the Draft's own `starts_at`, not today: #956 Q3 has the
 * two plans meet at one date, and that date is when the new one begins.
 */
userMembershipsRouter.post('/:id/activate', requireModuleWrite('PAYMENTS'), async (req, res, next) => {
  const { gymId, userId, role } = getTenantContext(req);
  const confirm = req.body?.confirm === true;
  try {
    // #1108 stage 2: the transition itself lives in `assignment-commit.ts`,
    // shared with the two payment-confirmation callers; this route is the
    // commit with no payment around it — a free plan, or a staff shortcut.
    const outcome = await db.transaction((tx) => commitAssignment(tx, {
      gymId, userMembershipId: String(req.params.id), fromStatuses: [ASSIGNMENT_CREATION_STATUS],
      confirm, source: sourceForRole(role), actorUserId: userId,
    }));
    if (outcome.kind === 'not_found') return res.status(404).json({ error: 'Membership not found' });
    if (outcome.kind === 'not_committable') {
      return res.status(400).json({
        error: `Only a Draft membership can be activated; this one is '${outcome.status}'.`,
      });
    }
    if (outcome.kind === 'bad_date') return res.status(400).json({ error: outcome.message });
    if (outcome.kind === 'conflict') {
      const activated = await loadAssignmentRow(gymId, req.params.id);
      return res.status(409).json(activePlanConflictBody(
        outcome.conflicts, activated?.plan_name ?? null,
      ));
    }
    const activated = await loadAssignmentRow(gymId, req.params.id);
    recordAudit(req, {
      action: 'activate', entityType: 'user_membership', entityId: req.params.id,
      next: activated,
      previous: {
        status: ASSIGNMENT_CREATION_STATUS,
        ...(outcome.superseded.length > 0
          ? { superseded_user_membership_ids: outcome.superseded } : {}),
      },
    });
    res.json(activated);
  } catch (err: any) {
    handleDupEntry(err, res, next, DUPLICATE_ASSIGNMENT_ERROR);
  }
});

/**
 * #1108 stage 2 — **Save & Pay**: the point of no return for a Draft.
 *
 * `draft -> pending_payment`: the configuration is committed and locked (a
 * pending row is in none of the editable, attachable or applicable status
 * lists), #956's one-plan rule is asked now — `409 active_plan_exists` unless
 * `confirm: true` — so the replacement is confirmed before the member is asked
 * to pay, and the payment is then collected around the row: the member's own
 * Pay now (`POST /me/payment-requests` accepts a pending row), a staff-raised
 * checkout link (`POST /payment-requests`), or a cash payment
 * (`POST /:id/record-payment`). The provider's webhook or the cash route is
 * what moves it on to `active`.
 *
 * A Draft that owes **nothing** for its first cycle — a free plan, a Free
 * Period — has no payment to wait for, so it is committed straight to
 * `active` here: a pending state nothing can ever confirm would strand it.
 */
userMembershipsRouter.post('/:id/save-and-pay', requireModuleWrite('PAYMENTS'), async (req, res, next) => {
  const { gymId, userId, role } = getTenantContext(req);
  const confirm = req.body?.confirm === true;
  try {
    const fee = await currentMembershipFee(gymId, Number(req.params.id));
    if (fee == null) return res.status(404).json({ error: 'Membership not found' });
    const owesNothing = !(fee > 0);

    const outcome: CommitOutcome | SubmitOutcome = await db.transaction(async (tx) => owesNothing
      ? commitAssignment(tx, {
        gymId, userMembershipId: String(req.params.id), fromStatuses: [ASSIGNMENT_CREATION_STATUS],
        confirm, source: sourceForRole(role), actorUserId: userId,
      })
      : submitForPayment(tx, {
        gymId, userMembershipId: String(req.params.id), confirm, source: sourceForRole(role), actorUserId: userId,
      }));
    if (outcome.kind === 'not_found') return res.status(404).json({ error: 'Membership not found' });
    if (outcome.kind === 'not_committable') {
      return res.status(400).json({
        error: `Only a Draft membership can be saved and paid; this one is '${outcome.status}'.`,
      });
    }
    if (outcome.kind === 'bad_date') return res.status(400).json({ error: outcome.message });
    if (outcome.kind === 'conflict') {
      const row = await loadAssignmentRow(gymId, req.params.id);
      return res.status(409).json(activePlanConflictBody(outcome.conflicts, row?.plan_name ?? null));
    }
    const row = await loadAssignmentRow(gymId, req.params.id);
    recordAudit(req, {
      action: owesNothing ? 'activate' : 'save_and_pay', entityType: 'user_membership', entityId: req.params.id,
      next: row, previous: { status: ASSIGNMENT_CREATION_STATUS },
    });
    res.json({ ...row, membership_fee: fee });
  } catch (err: any) {
    next(err);
  }
});

/**
 * #1108 stage 2 — a **cash / manual** first payment confirms a Pending
 * Payment row: one `payment_recorded` Billing Event (`source` from the role,
 * the membership-fee charge type, the fee the cycle resolves to unless an
 * explicit amount is given) and the very same commit the webhook runs, in one
 * transaction. No card is stored and no `next_billing_date` is stamped — a cash
 * member has no card for the nightly run to charge, exactly as before.
 */
userMembershipsRouter.post('/:id/record-payment', requireModuleWrite('PAYMENTS'), async (req, res, next) => {
  const { gymId, userId, role } = getTenantContext(req);
  const { amount, notes } = req.body ?? {};
  try {
    const fee = await currentMembershipFee(gymId, Number(req.params.id));
    if (fee == null) return res.status(404).json({ error: 'Membership not found' });
    let paid = fee;
    if (amount != null && amount !== '') {
      const parsed = parseFloat(String(amount));
      if (isNaN(parsed) || parsed <= 0) return res.status(400).json({ error: 'amount must be greater than 0' });
      paid = parsed;
    }
    const { rows: ctRows } = await db.query<{ id: number }>(
      `SELECT id FROM charge_types WHERE code = 'membership_fee' LIMIT 1`,
    );
    if (!ctRows[0]) return res.status(500).json({ error: 'charge_type membership_fee not configured' });

    const outcome = await db.transaction(async (tx) => {
      const committed = await commitAssignment(tx, {
        gymId, userMembershipId: String(req.params.id), fromStatuses: [PENDING_PAYMENT_STATUS],
        confirm: true, source: sourceForRole(role), actorUserId: userId,
      });
      if (committed.kind !== 'committed') return committed;
      await tx.query(
        `INSERT INTO billing_events
           (gym_id, user_membership_id, member_id, event_type, amount, charge_type_id, source, actor_user_id, notes)
         VALUES (?, ?, ?, 'payment_recorded', ?, ?, ?, ?, ?)`,
        [gymId, req.params.id, committed.memberId, paid.toFixed(2), ctRows[0].id, sourceForRole(role), userId,
         typeof notes === 'string' && notes.trim() ? notes.trim().slice(0, 500) : null],
      );
      return committed;
    });
    if (outcome.kind === 'not_found') return res.status(404).json({ error: 'Membership not found' });
    if (outcome.kind === 'not_committable') {
      return res.status(400).json({
        error: `Only a membership pending payment can have its payment recorded; this one is '${outcome.status}'.`,
      });
    }
    if (outcome.kind === 'bad_date') return res.status(400).json({ error: outcome.message });
    if (outcome.kind === 'conflict') {
      // Unreachable with `confirm: true`; typed for completeness.
      const row = await loadAssignmentRow(gymId, req.params.id);
      return res.status(409).json(activePlanConflictBody(outcome.conflicts, row?.plan_name ?? null));
    }
    const row = await loadAssignmentRow(gymId, req.params.id);
    recordAudit(req, {
      action: 'record_payment', entityType: 'user_membership', entityId: req.params.id,
      next: row,
      previous: {
        status: PENDING_PAYMENT_STATUS, amount: paid.toFixed(2),
        ...(outcome.superseded.length > 0 ? { superseded_user_membership_ids: outcome.superseded } : {}),
      },
    });
    res.json(row);
  } catch (err: any) {
    next(err);
  }
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

// Assign New Plan (#412): the member's next Membership Plan, configured as the
// replacement for the one named in the URL.
//
// #956 made replacement this route's whole contract and superseded the named
// row inside the insert transaction. #1108 stage 1 moved that: the successor is
// created as a **Draft**, so the plan being replaced keeps running while the new
// one is configured, and `POST /:id/activate` is where every live assignment
// covering this member is found, 409'd or superseded — one transition rather
// than four insert paths, and the one place `confirm` is answered. The
// superseded row is still `cancelled` with its dates stamped rather than
// `expired` (#956 Q3), through `supersedeLiveAssignments()` and nowhere else.
//
// The row named in the URL is therefore still what this route is *about* — it
// is read for its owner and it is what the Draft replaces — but nothing about
// it is written here.
//
// #628: the caller may also pick the Promotions to apply to the new
// assignment (`promotion_ids`). They are validated as a set *before* the
// membership is created — `applyPromotionToMembership` opens its own
// transaction, so the applies can only run after this one commits, and an
// invalid selection must never leave a half-configured assignment behind.
userMembershipsRouter.post('/:id/assign-new-plan', requireRole('admin'), async (req, res, next) => {
  const { gymId, userId, role, actorName, isSuperadmin } = getTenantContext(req);
  // #958 — the creation actor of the assignment this route creates (migration 215).
  const actor = actorSnapshot({ name: actorName, isSuperadmin });
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

  const confirm = req.body?.confirm === true;

  try {
    const outcome = await db.transaction(async (tx) => {
      const { rows: current } = await tx.query(
        'SELECT id, member_id, status FROM user_memberships WHERE id = ? AND gym_id = ? FOR UPDATE',
        [req.params.id, gymId],
      );
      if (current.length === 0) return { kind: 'not_found' as const };
      const prev = current[0];

      // #1108 stage 1: the successor is created as a **Draft**, so nothing is
      // superseded here. The plan named in the URL keeps running while its
      // replacement is configured — which is what a Draft is for — and it is
      // the `draft -> active` commit (`POST /:id/activate`) that finds every
      // live assignment covering this member, answers the 409 or supersedes
      // them. That moved #956's whole enforcement, including this route's
      // `confirm`, onto one transition instead of four insert paths.
      const { insertId } = await tx.query(
        `INSERT INTO user_memberships
         (member_id, gym_id, membership_plan_id, base_price, plan_price_id,
          discount_reason, discount_expires_at, starts_at, ends_at, status,
          created_by_name, created_by_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          prev.member_id, gymId, membership_plan_id,
          eff.base_price, eff.plan_price_id,
          feeOverride ? String(discount_reason).trim() : null,
          discount_expires_at || null,
          starts_at, ends_at ?? null,
          ASSIGNMENT_CREATION_STATUS,
          // #958 — the successor is a new Assigned Plan, so it records who
          // assigned *it* (migration 215); the superseded row keeps its own.
          actor.name, actor.type,
        ],
      );
      await recordStatusChange(tx, {
        gymId, userMembershipId: insertId, memberId: prev.member_id,
        previousStatus: null, newStatus: ASSIGNMENT_CREATION_STATUS,
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
      return { kind: 'created' as const, insertId };
    });
    if (outcome.kind === 'not_found') return res.status(404).json({ error: 'Membership not found' });
    const newId = outcome.insertId;

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
      next: created,
      // The Draft is configured *as* the replacement for the row named in the
      // URL, so that is what the audit records. Which assignments it actually
      // supersedes is `POST /:id/activate`'s own audit row, because that is
      // where the cancellation happens (#1108 stage 1).
      previous: { supersedes_user_membership_id: Number(req.params.id) },
    });
    res.status(201).json({ ...created, applied_promotion_ids: promotionIds });
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    handleDupEntry(err, res, next, DUPLICATE_ASSIGNMENT_ERROR);
  }
});

// ─── Lifecycle actions (#511 stage 1 — Assigned Plans status model) ───────────
// pause/reactivate share the same shape: lock the row, check the
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
    // #785: reactivating means "bill this again", so the nightly run's dunning
    // state starts over. An assignment the run paused carries
    // `failed_attempts = 2`; leaving it there would give the resumed assignment
    // one attempt instead of the documented two — the next rejection would pause
    // it immediately. Only on the way *to* `active`: pausing or cancelling has
    // no reason to forget how the last cycle went.
    const resetDunning = targetStatus === 'active'
      ? ', failed_attempts = 0, last_failed_at = NULL'
      : '';
    await tx.query(
      `UPDATE user_memberships SET status = ?${resetDunning} WHERE id = ? AND gym_id = ?`,
      [targetStatus, prev.id, gymId],
    );
    // #790: and "again" means from the next boundary after today — a pause is
    // not a debt, so the cycles that went by while it was paused are not
    // charged one per night when it comes back.
    if (targetStatus === 'active') {
      await rollStaleNextBillingDateForward(tx, prev.id, gymId);
    }
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
// #1108 stage 1: `draft` closes too, and this is how a Draft is discarded —
// Q1a's answer is that a Draft with no payment behind it simply sits there
// until staff cancel or delete it, with no expiry sweep, so it needs a way out
// that is not activation. Closing one is also always warning-free, because
// `computeUnusedValueWarnings()` reads `next_billing_date`, which a Draft has
// never had.
const CLOSEABLE_FROM: readonly Status[] = ['draft', 'pending_payment', 'active', 'paused'];

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
// Products are untouched, which is exactly what makes the ticket's
// "Assigned Plan A → €90, Assigned Plan B → €100, Membership Plan → €100"
// example hold.
//
// Since stage 3 these rows are what the assignment bills, so an edit here moves
// its Billing Simulation immediately — there is no second place to write.

// A terminal assignment is history: it bills nothing further, so rewriting the
// configuration it was agreed with would only falsify the record. Same reasoning
// as ATTACHABLE_STATUSES in user-membership-services.ts.
// #1108 §2: a Draft is *fully editable* — it is the pre-checkout configuration
// state, so every section of its snapshot is writable until it is committed.
const SNAPSHOT_EDITABLE_STATUSES: readonly Status[] = ['draft', 'active', 'paused'];

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
            free_periods, paid_periods, bonus_periods, pay_beforehand_periods,
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
  for (const field of ['free_periods', 'paid_periods', 'bonus_periods', 'pay_beforehand_periods', 'recurring_billing_interval'] as const) {
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
        `SELECT recurring_billing_interval, recurring_billing_unit, paid_periods, pay_beforehand_periods
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
      const nextPaid = 'paid_periods' in patch ? patch.paid_periods : current[0].paid_periods;
      const nextPrepaid = 'pay_beforehand_periods' in patch
        ? patch.pay_beforehand_periods : current[0].pay_beforehand_periods;
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
        free_periods: um.free_periods, paid_periods: um.paid_periods, bonus_periods: um.bonus_periods,
        pay_beforehand_periods: um.pay_beforehand_periods,
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
      return res.status(400).json({ error: 'pay_beforehand_periods cannot exceed paid_periods' });
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

// One route per benefit kind, with the replace-all `{ items: [{ product_id,
// quantity }] }` payload the Plan and Promotion sections already take — the
// admin editors are shared, so the contract has to be the same one. What
// differs is what a row means: on a Plan it points at the live Product,
// here it *is* the agreed line, so the write freezes the item's commercial
// facts (`writeAssignedPlanBenefitSection`).
const ASSIGNED_BENEFIT_ROUTES: { path: string; category: ProductBenefitCategory }[] = [
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

    const parsed: { product_id: number; quantity: number }[] = [];
    const seen = new Set<number>();
    for (const item of items) {
      const productId = parseInt(item?.product_id, 10);
      const quantity = parseInt(item?.quantity, 10);
      if (!Number.isInteger(productId) || productId <= 0) {
        return res.status(400).json({ error: 'product_id is required' });
      }
      if (!Number.isInteger(quantity) || quantity <= 0) {
        return res.status(400).json({ error: 'quantity must be a positive integer' });
      }
      if (seen.has(productId)) return res.status(400).json({ error: `Duplicate product_id: ${productId}` });
      seen.add(productId);
      parsed.push({ product_id: productId, quantity });
    }

    // A line already in this section is part of what was agreed, so it stays
    // saveable whatever has since happened to the Product — retired,
    // deactivated or reclassified. Only a *newly* added item is held to the
    // catalogue's current state, and to the section's own category.
    const current = await loadAssignedPlanBenefitSection(gymId, Number(um.id), category);
    const alreadyAttached = new Set(current.map((row) => row.product_id));
    const added = parsed.filter((item) => !alreadyAttached.has(item.product_id)).map((i) => i.product_id);
    if (added.length > 0) {
      const marks = added.map(() => '?').join(',');
      const { rows: products } = await db.query(
        `SELECT id, type, billing_frequency, status FROM products
         WHERE gym_id = ? AND deleted_at IS NULL AND id IN (${marks})`,
        [gymId, ...added],
      );
      if (products.length !== added.length) {
        return res.status(400).json({ error: 'One or more Products not found in this gym' });
      }
      const inactive = products.find((si: any) => si.status !== 'active');
      if (inactive) {
        return res.status(400).json({ error: `Product ${inactive.id} is not active in this gym` });
      }
      const mismatched = products.find((si: any) => classifyProduct(si) !== category);
      if (mismatched) {
        return res.status(400).json({ error: `Product ${mismatched.id} does not belong in the '${category}' category` });
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
        previous: { [`${category}_benefits`]: current.map((r) => ({ product_id: r.product_id, quantity: r.quantity })) },
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
    `SELECT um.id, um.membership_plan_id, p.member_limit FROM user_memberships um
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
    // #956: covering a Member is the fourth way they come to hold a Membership
    // Plan, so the rule applies here too — a Member who already has a live one
    // cannot be added to a second. Unlike the three assignment paths this one
    // offers **no** `confirm` replacement: the ticket settles the effective date
    // of a replacement as the new plan's `starts_at` (Q3), and coverage added to
    // a plan that started months ago has no such date to end their own plan on.
    // So the staff action is the explicit one — close their plan, then add them —
    // and the conflict payload names what is in the way.
    const coverageConflict = await db.transaction(async (tx) => {
      const conflicts = await findLiveAssignmentsForMembers(tx, gymId, [Number(member_id)], {
        excludeUserMembershipId: Number(req.params.id),
      });
      return conflicts.length > 0 ? conflicts : null;
    });
    if (coverageConflict) {
      const body = activePlanConflictBody(
        coverageConflict, await membershipPlanName(gymId, Number(membership.membership_plan_id)),
      );
      return res.status(409).json({
        ...body,
        message: `${body.current_plan.blocked_member_name ?? 'This member'} already has an active `
          + 'Membership Plan. Close it before adding them to this one.',
      });
    }
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
