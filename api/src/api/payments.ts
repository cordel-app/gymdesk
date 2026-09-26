import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { parseQuery, z } from '../infra/validate';
import { recordAudit } from '../infra/audit';
import { insertAndFetch } from '../infra/db-helpers';
import { sourceForRole } from './billing-events';
import { applyPromotionToMembership } from './membership-promotions';
import { generateReceiptPdf } from '../lib/receipt-pdf';
import {
  BILLING_EVENT_STATUSES,
  deriveBillingEventStatus,
  isPaymentActionable,
} from '../domain/billingEventStatus';
import { recordManualPayment, retryBillingEventPayment } from '../domain/billingEventPayments';
import { ASSIGNMENT_CADENCE } from './assigned-plan-snapshot';
import {
  MEMBERSHIP_FEE_COLUMNS,
  MembershipFeeRow,
  loadMembershipFeeResolvers,
} from './membership-fee-pricing';

/**
 * #129: Payments module — operational payment actions over billing_events.
 * Distinct from /billing-events (finance/accounting view) in:
 *   - no role gate (staff-accessible by default via requireRole('admin','staff'))
 *   - excludes status_changed system events from list views
 *   - exposes apply-promotion as a first-class payment operation
 */

const PAYMENT_EVENT_TYPES = ['charge_created', 'payment_recorded', 'adjustment'] as const;
const SOURCES = ['admin', 'system', 'employee', 'customer', 'provider'] as const;

// #416 — billing-events admin view status filter. `status` is derived (#640: from
// the latest linked Payment Transaction, falling back to `event_type`; see
// `domain/billingEventStatus.ts`), not a stored column, so it can't be pushed
// into SQL WHERE.

// Accepts repeated `status=a&status=b` or a single comma-separated value.
const billingEventStatusParam = z.preprocess((v) => {
  if (v === undefined) return undefined;
  const arr = Array.isArray(v) ? v : [v];
  return arr.flatMap((s) => String(s).split(',').map((x) => x.trim())).filter(Boolean);
}, z.array(z.enum(BILLING_EVENT_STATUSES)).optional());

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const LIST_SELECT = `
  SELECT be.*,
         m.name AS member_name,
         ct.code AS charge_type_code
  FROM billing_events be
  LEFT JOIN members m ON m.id = be.member_id
  LEFT JOIN charge_types ct ON ct.id = be.charge_type_id
`;

export const paymentsRouter = Router();

paymentsRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const q = parseQuery(req, res, z.object({
    member_id: z.coerce.number().int().positive().optional(),
    source: z.enum(SOURCES).optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
    offset: z.coerce.number().int().min(0).default(0),
  }));
  if (!q) return;

  const where: string[] = ["be.gym_id = ?", "be.event_type != 'status_changed'"];
  const params: any[] = [gymId];
  if (q.member_id !== undefined) { where.push('be.member_id = ?'); params.push(q.member_id); }
  if (q.source) { where.push('be.source = ?'); params.push(q.source); }
  if (q.from) { where.push('be.created_at >= ?'); params.push(q.from.length === 10 ? `${q.from} 00:00:00` : q.from); }
  if (q.to) { where.push('be.created_at <= ?'); params.push(q.to.length === 10 ? `${q.to} 23:59:59` : q.to); }

  const limit = q.limit;
  const offset = q.offset;
  const whereSql = where.join(' AND ');

  const { rows: countRows } = await db.query(
    `SELECT COUNT(*) AS total FROM billing_events be WHERE ${whereSql}`, params,
  );
  const { rows } = await db.query(
    `${LIST_SELECT} WHERE ${whereSql} ORDER BY be.created_at DESC, be.id DESC LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  res.json({ items: rows, total: Number(countRows[0].total), limit, offset });
});

paymentsRouter.post('/', requireModuleWrite('PAYMENTS'), async (req, res, next) => {
  const { gymId, userId, role } = getTenantContext(req);
  const { event_type, member_id, user_membership_id, charge_type_id, amount, notes, source } = req.body;

  if (!PAYMENT_EVENT_TYPES.includes(event_type)) {
    return res.status(400).json({ error: `event_type must be one of: ${PAYMENT_EVENT_TYPES.join(', ')}` });
  }
  if (source && !SOURCES.includes(source)) {
    return res.status(400).json({ error: `source must be one of: ${SOURCES.join(', ')}` });
  }
  if (!member_id && !user_membership_id) {
    return res.status(400).json({ error: 'member_id or user_membership_id is required' });
  }

  const parsedAmount = amount != null && amount !== '' ? parseFloat(amount) : null;
  if (parsedAmount !== null && isNaN(parsedAmount)) {
    return res.status(400).json({ error: 'amount must be a number' });
  }
  if (event_type === 'payment_recorded' || event_type === 'charge_created') {
    if (parsedAmount === null || parsedAmount <= 0) {
      return res.status(400).json({ error: 'amount must be greater than 0' });
    }
    if (!charge_type_id) {
      return res.status(400).json({ error: 'charge_type_id is required' });
    }
  }
  if (event_type === 'adjustment' && (parsedAmount === null || parsedAmount === 0)) {
    return res.status(400).json({ error: 'amount is required and must be non-zero for adjustments' });
  }

  if (charge_type_id) {
    const { rows } = await db.query('SELECT id FROM charge_types WHERE id = ? AND active = TRUE', [charge_type_id]);
    if (rows.length === 0) return res.status(400).json({ error: 'Unknown or inactive charge type' });
  }

  let memberId: number | null = member_id ?? null;
  if (user_membership_id) {
    const { rows } = await db.query(
      'SELECT id, member_id FROM user_memberships WHERE id = ? AND gym_id = ?',
      [user_membership_id, gymId],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Membership not found' });
    if (memberId && Number(memberId) !== rows[0].member_id) {
      return res.status(400).json({ error: 'member_id does not match the membership' });
    }
    memberId = rows[0].member_id;
  } else {
    const { rows } = await db.query('SELECT id FROM members WHERE id = ? AND gym_id = ?', [memberId, gymId]);
    if (rows.length === 0) return res.status(404).json({ error: 'Member not found' });
  }

  try {
    const row = await insertAndFetch(
      `INSERT INTO billing_events
       (gym_id, user_membership_id, member_id, event_type, charge_type_id, source, actor_user_id, amount, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        gymId, user_membership_id ?? null, memberId, event_type, charge_type_id ?? null,
        source ?? sourceForRole(role), userId, parsedAmount,
        notes && String(notes).trim() ? String(notes).trim() : null,
      ],
      `${LIST_SELECT} WHERE be.id = ?`,
      (id) => [id],
    );
    recordAudit(req, { action: 'append', entityType: 'billing_event', entityId: row.id, next: row });
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

paymentsRouter.get('/member/:memberId', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const memberId = parseInt(String(req.params.memberId), 10);
  if (!memberId) return res.status(400).json({ error: 'Invalid memberId' });

  const { rows: memberRows } = await db.query('SELECT id FROM members WHERE id = ? AND gym_id = ?', [memberId, gymId]);
  if (memberRows.length === 0) return res.status(404).json({ error: 'Member not found' });

  const pq = parseQuery(req, res, z.object({
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
    offset: z.coerce.number().int().min(0).default(0),
  }));
  if (!pq) return;
  const limit = pq.limit;
  const offset = pq.offset;

  const { rows: countRows } = await db.query(
    "SELECT COUNT(*) AS total FROM billing_events be WHERE be.gym_id = ? AND be.member_id = ? AND be.event_type != 'status_changed'",
    [gymId, memberId],
  );
  const { rows } = await db.query(
    `${LIST_SELECT} WHERE be.gym_id = ? AND be.member_id = ? AND be.event_type != 'status_changed' ORDER BY be.created_at DESC, be.id DESC LIMIT ${limit} OFFSET ${offset}`,
    [gymId, memberId],
  );
  res.json({ items: rows, total: Number(countRows[0].total), limit, offset });
});

// ── Billing Events (admin view) ───────────────────────────────────────────────
// Billing Event = billing_events row (parent); Payment Transaction = payment_requests row (child).
// Past rows come from DB; future rows are projected from user_memberships.next_billing_date.

function advanceBillingDate(
  current: string,
  interval: number,
  unit: 'day' | 'week' | 'month' | 'year',
): string {
  const d = new Date(current);
  switch (unit) {
    case 'day':   d.setUTCDate(d.getUTCDate() + interval); break;
    case 'week':  d.setUTCDate(d.getUTCDate() + interval * 7); break;
    case 'month': d.setUTCMonth(d.getUTCMonth() + interval); break;
    case 'year':  d.setUTCFullYear(d.getUTCFullYear() + interval); break;
  }
  return d.toISOString().slice(0, 10);
}

/**
 * mysql2 hands back DATE columns as JS Date objects at UTC midnight (pool
 * timezone 'Z'), so `String(date).slice(0, 10)` yields "Wed Oct 21" instead of
 * an ISO date. Normalises either representation to YYYY-MM-DD.
 */
function toDateOnly(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

paymentsRouter.get('/billing-events', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const q = parseQuery(req, res, z.object({
    member_id: z.coerce.number().int().positive().optional(),
    status: billingEventStatusParam,
    from: z.string().optional(),
    to: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
    offset: z.coerce.number().int().min(0).default(0),
  }));
  if (!q) return;

  try {
    // ── Real (past) billing events ──
    const where: string[] = ['be.gym_id = ?'];
    const params: any[] = [gymId];
    if (q.member_id !== undefined) { where.push('be.member_id = ?'); params.push(q.member_id); }
    if (q.from) { where.push('DATE(be.created_at) >= ?'); params.push(q.from.slice(0, 10)); }
    if (q.to)   { where.push('DATE(be.created_at) <= ?'); params.push(q.to.slice(0, 10)); }
    const whereSql = where.join(' AND ');

    const { rows: realRows } = await db.query<{
      id: number; member_id: number; member_name: string | null;
      user_membership_id: number | null; plan_name: string | null;
      created_at: Date; amount: string | null; event_type: string;
      currency: string | null;
      membership_status: string | null; next_billing_date: Date | string | null;
      latest_tx_status: string | null;
    }>(
      `SELECT be.id, be.member_id, m.name AS member_name,
              be.user_membership_id, mp.name AS plan_name,
              be.created_at, be.amount, be.event_type, NULL AS currency,
              um.status AS membership_status, um.next_billing_date,
              (SELECT pr.status FROM payment_requests pr
                WHERE pr.billing_event_id = be.id
                ORDER BY pr.created_at DESC, pr.id DESC LIMIT 1) AS latest_tx_status
       FROM billing_events be
       LEFT JOIN members m ON m.id = be.member_id
       LEFT JOIN user_memberships um ON um.id = be.user_membership_id
       LEFT JOIN membership_plans mp ON mp.id = um.membership_plan_id
       WHERE ${whereSql}
       ORDER BY be.created_at DESC, be.id DESC
       LIMIT 10000`,
      params,
    );

    // #639: `created_at` is the ledger row's own creation instant (ISO datetime,
    // UTC). `next_payment_date` is when the next payment is scheduled to run for
    // the membership the event belongs to — i.e. `user_memberships.next_billing_date`,
    // the same value the nightly billing run charges on. It is null (rendered as
    // "—") when the event has no membership, or the membership is no longer active,
    // or nothing is scheduled. It is a DATE column, so it carries no time of day.
    type BillingEventRow = {
      id: number | null; type: 'real' | 'virtual';
      member_id: number; member_name: string | null;
      user_membership_id: number | null; plan_name: string | null;
      billing_date: string; amount: string | null;
      event_type: string; status: string; currency: string | null;
      created_at: string | null; next_payment_date: string | null;
      /** #640: whether Retry Payment / Manual payment apply to this row. */
      payment_actions_available: boolean;
    };

    const past: BillingEventRow[] = realRows.map((r) => {
      const status = deriveBillingEventStatus(r.event_type, r.latest_tx_status);
      return {
        id: r.id,
        type: 'real' as const,
        member_id: r.member_id,
        member_name: r.member_name,
        user_membership_id: r.user_membership_id,
        plan_name: r.plan_name,
        billing_date: new Date(r.created_at).toISOString().slice(0, 10),
        created_at: new Date(r.created_at).toISOString(),
        next_payment_date: r.membership_status === 'active' ? toDateOnly(r.next_billing_date) : null,
        amount: r.amount,
        event_type: r.event_type,
        status,
        currency: r.currency,
        // A transaction needs a membership to hang off, and a charge needs an
        // amount — an event missing either offers no payment action.
        payment_actions_available:
          isPaymentActionable(status) && r.user_membership_id != null && parseFloat(r.amount ?? '0') > 0,
      };
    });

    // ── Future (virtual) billing events — rolling 5-date window per active membership ──
    const futureWhere: string[] = [
      'um.gym_id = ?',
      "um.status = 'active'",
      'um.next_billing_date IS NOT NULL',
      // #635 stage 3 — the assignment's own cadence, else its Plan's live one.
      `${ASSIGNMENT_CADENCE.interval()} IS NOT NULL`,
      `${ASSIGNMENT_CADENCE.unit()} IS NOT NULL`,
    ];
    const futureParams: any[] = [gymId];
    if (q.member_id !== undefined) { futureWhere.push('um.member_id = ?'); futureParams.push(q.member_id); }

    const includeScheduled = !q.status || q.status.includes('scheduled');
    const activeRows = includeScheduled ? (await db.query<MembershipFeeRow & {
      user_membership_id: number; member_id: number; member_name: string | null;
      plan_name: string | null; next_billing_date: Date | string;
      recurring_billing_interval: number; recurring_billing_unit: 'day' | 'week' | 'month' | 'year';
      currency: string | null;
    }>(
      `SELECT um.id AS user_membership_id, um.member_id, m.name AS member_name,
              mp.name AS plan_name, um.next_billing_date,
              ${ASSIGNMENT_CADENCE.interval()} AS recurring_billing_interval,
              ${ASSIGNMENT_CADENCE.unit()} AS recurring_billing_unit,
              ${MEMBERSHIP_FEE_COLUMNS}, NULL AS currency
       FROM user_memberships um
       LEFT JOIN membership_plans p ON p.id = um.membership_plan_id
       LEFT JOIN billing_policies bp ON bp.membership_plan_id = um.membership_plan_id
       LEFT JOIN members m ON m.id = um.member_id
       LEFT JOIN membership_plans mp ON mp.id = um.membership_plan_id
       WHERE ${futureWhere.join(' AND ')}`,
      futureParams,
    )).rows : [];

    const today = new Date().toISOString().slice(0, 10);
    const future: BillingEventRow[] = [];

    // #635 stage 15 — each projected cycle is priced on its own date by the one
    // Membership Fee rule, so a Free Period, a Pre-paid or Bonus Duration and a
    // Promotion whose months have run out all show here exactly as the nightly run
    // will charge them. Loaded for the whole page in a bounded number of queries;
    // pricing the five dates of each assignment off that is pure.
    const feeResolvers = await loadMembershipFeeResolvers(gymId, activeRows);

    for (const um of activeRows) {
      const nextPaymentDate = toDateOnly(um.next_billing_date);
      if (!nextPaymentDate) continue;
      const priceOn = feeResolvers.get(um.id)!.priceOn;
      let date = nextPaymentDate;
      for (let i = 0; i < 5; i++) {
        if (date < today) {
          date = advanceBillingDate(date, um.recurring_billing_interval, um.recurring_billing_unit);
          continue;
        }
        if (q.from && date < q.from.slice(0, 10)) { date = advanceBillingDate(date, um.recurring_billing_interval, um.recurring_billing_unit); continue; }
        if (q.to   && date > q.to.slice(0, 10))   break;

        future.push({
          id: null as any,
          type: 'virtual',
          member_id: um.member_id,
          member_name: um.member_name,
          user_membership_id: um.user_membership_id,
          plan_name: um.plan_name,
          billing_date: date,
          // Projected rows aren't persisted yet, so they have no creation instant.
          created_at: null,
          next_payment_date: nextPaymentDate,
          amount: priceOn(date).amount.toFixed(2),
          event_type: 'upcoming',
          status: 'scheduled',
          currency: um.currency,
          payment_actions_available: false,
        });
        date = advanceBillingDate(date, um.recurring_billing_interval, um.recurring_billing_unit);
      }
    }

    // Merge, sort DESC by billing_date
    const merged = [...past, ...future].sort((a, b) => {
      if (b.billing_date !== a.billing_date) return b.billing_date < a.billing_date ? -1 : 1;
      return (b.id ?? 0) - (a.id ?? 0);
    });
    const all = q.status?.length ? merged.filter((r) => q.status!.includes(r.status as any)) : merged;

    const total = all.length;
    const items = all.slice(q.offset, q.offset + q.limit);
    res.json({ items, total, limit: q.limit, offset: q.offset });
  } catch (err) {
    next(err);
  }
});

// GET /payments/billing-events/:id/transactions
// Returns payment_requests rows linked to a billing_events row.
paymentsRouter.get('/billing-events/:id/transactions', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const billingEventId = parseInt(String(req.params.id), 10);
  if (!billingEventId) return res.status(400).json({ error: 'Invalid id' });

  try {
    const { rows: evRows } = await db.query('SELECT id FROM billing_events WHERE id = ? AND gym_id = ?', [billingEventId, gymId]);
    if (evRows.length === 0) return res.status(404).json({ error: 'Billing event not found' });

    const { rows } = await db.query<any>(
      `SELECT pr.id, pr.status, pr.amount, pr.currency, pr.provider, pr.provider_order,
              pr.provider_ref, pr.source, pr.created_at, pr.completed_at,
              pr.attempt, pr.failure_code, pr.failure_message, pr.notes,
              pr.modified_at,
              (SELECT gm.name FROM gym_memberships gm
                WHERE gm.user_id = pr.modified_by_user_id AND gm.gym_id = pr.gym_id
                LIMIT 1) AS modified_by_name,
              m.name AS member_name,
              mp.name AS plan_name,
              pm.card_brand, pm.card_last4
       FROM payment_requests pr
       LEFT JOIN members m ON m.id = pr.member_id
       LEFT JOIN user_memberships um ON um.id = pr.user_membership_id
       LEFT JOIN membership_plans mp ON mp.id = um.membership_plan_id
       LEFT JOIN payment_methods pm ON pm.member_id = pr.member_id AND pm.gym_id = pr.gym_id
       WHERE pr.billing_event_id = ? AND pr.gym_id = ?
       ORDER BY pr.created_at DESC`,
      [billingEventId, gymId],
    );
    res.json({ items: rows });
  } catch (err) {
    next(err);
  }
});

// ── #640: Billing Event details + audited payment actions ────────────────────

/**
 * GET /payments/billing-events/:id — read-only Details view (§2).
 *
 * Created By / Modified By are Clerk user ids on the row, resolved to a display
 * name through `gym_memberships.name` (the same join the audit registry uses
 * for `gym_user`); a system-generated event has no actor at all.
 */
paymentsRouter.get('/billing-events/:id', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const billingEventId = parseInt(String(req.params.id), 10);
  if (!billingEventId) return res.status(400).json({ error: 'Invalid id' });

  try {
    const { rows } = await db.query<any>(
      `SELECT be.id, be.member_id, be.user_membership_id, be.event_type, be.amount,
              be.notes, be.source, be.actor_user_id, be.created_at,
              be.previous_status, be.new_status,
              be.receipt_number, be.receipt_issued_at,
              be.modified_at, be.modified_by_user_id,
              ct.code AS charge_type_code,
              m.name AS member_name,
              mp.name AS plan_name,
              um.status AS membership_status, um.next_billing_date,
              (SELECT gm.name FROM gym_memberships gm
                WHERE gm.user_id = be.actor_user_id AND gm.gym_id = be.gym_id LIMIT 1) AS created_by_name,
              (SELECT gm.name FROM gym_memberships gm
                WHERE gm.user_id = be.modified_by_user_id AND gm.gym_id = be.gym_id LIMIT 1) AS modified_by_name,
              (SELECT pr.status FROM payment_requests pr
                WHERE pr.billing_event_id = be.id
                ORDER BY pr.created_at DESC, pr.id DESC LIMIT 1) AS latest_tx_status,
              (SELECT CONCAT_WS(': ', pr.failure_code, pr.failure_message) FROM payment_requests pr
                WHERE pr.billing_event_id = be.id AND pr.failure_code IS NOT NULL
                ORDER BY pr.created_at DESC, pr.id DESC LIMIT 1) AS transaction_failure_reason
         FROM billing_events be
         LEFT JOIN charge_types ct ON ct.id = be.charge_type_id
         LEFT JOIN members m ON m.id = be.member_id
         LEFT JOIN user_memberships um ON um.id = be.user_membership_id
         LEFT JOIN membership_plans mp ON mp.id = um.membership_plan_id
        WHERE be.id = ? AND be.gym_id = ?`,
      [billingEventId, gymId],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Billing event not found' });
    const be = rows[0];

    const status = deriveBillingEventStatus(be.event_type, be.latest_tx_status);
    const actionable =
      isPaymentActionable(status) && be.user_membership_id != null && parseFloat(be.amount ?? '0') > 0;

    // The nightly run records a failed charge's reason on the ledger row's
    // notes; a transaction-level reason (#640) is more specific, so it wins.
    const failureReason = be.transaction_failure_reason
      ?? (status === 'failed' ? be.notes ?? null : null);

    res.json({
      id: be.id,
      member_id: be.member_id,
      member_name: be.member_name,
      user_membership_id: be.user_membership_id,
      plan_name: be.plan_name,
      amount: be.amount,
      currency: 'EUR',
      status,
      event_type: be.event_type,
      charge_type_code: be.charge_type_code,
      source: be.source,
      notes: be.notes,
      previous_status: be.previous_status,
      new_status: be.new_status,
      receipt_number: be.receipt_number,
      receipt_issued_at: be.receipt_issued_at ? new Date(be.receipt_issued_at).toISOString() : null,
      created_at: new Date(be.created_at).toISOString(),
      created_by: be.created_by_name ?? (be.actor_user_id ? be.actor_user_id : null),
      modified_at: be.modified_at ? new Date(be.modified_at).toISOString() : null,
      modified_by: be.modified_by_name ?? (be.modified_by_user_id ? be.modified_by_user_id : null),
      next_payment_date: be.membership_status === 'active' ? toDateOnly(be.next_billing_date) : null,
      failure_reason: failureReason,
      can_retry: actionable,
      can_record_manual_payment: actionable,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /payments/billing-events/:id/retry — Retry Payment (§3).
 * Never appends a Billing Event: the retry is a new Payment Transaction
 * against this one. Two rejections in a row pause the assigned plan.
 */
paymentsRouter.post('/billing-events/:id/retry', requireModuleWrite('PAYMENTS'), async (req, res, next) => {
  const { gymId, userId, role } = getTenantContext(req);
  const billingEventId = parseInt(String(req.params.id), 10);
  if (!billingEventId) return res.status(400).json({ error: 'Invalid id' });

  try {
    const outcome = await retryBillingEventPayment(gymId, billingEventId, userId, sourceForRole(role));
    if ('failure' in outcome) {
      return res.status(outcome.failure.status).json({ error: outcome.failure.error });
    }
    const { result } = outcome;
    // §5: the manual intervention is what the audit trail records — action,
    // event, actor, timestamp, previous/new status, and the attempt results.
    recordAudit(req, {
      action: 'retry_payment',
      entityType: 'billing_event',
      entityId: result.billing_event_id,
      previous: { status: result.previous_status },
      next: {
        status: result.new_status,
        attempts: result.attempts,
        membership_paused: result.membership_paused,
      },
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /payments/billing-events/:id/manual-payment — Manual payment (§4,
 * the action the ticket first called "Flag as Paid"). Records a front-desk
 * settlement as a completed Payment Transaction; no provider call.
 */
paymentsRouter.post('/billing-events/:id/manual-payment', requireModuleWrite('PAYMENTS'), async (req, res, next) => {
  const { gymId, userId } = getTenantContext(req);
  const billingEventId = parseInt(String(req.params.id), 10);
  if (!billingEventId) return res.status(400).json({ error: 'Invalid id' });

  try {
    const outcome = await recordManualPayment(gymId, billingEventId, userId, req.body ?? {});
    if ('failure' in outcome) {
      return res.status(outcome.failure.status).json({ error: outcome.failure.error });
    }
    const { result } = outcome;
    recordAudit(req, {
      action: 'manual_payment',
      entityType: 'billing_event',
      entityId: result.billing_event_id,
      previous: { status: result.previous_status },
      next: {
        status: result.new_status,
        payment_request_id: result.payment_request_id,
        amount: result.amount,
        notes: result.notes,
      },
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

paymentsRouter.post('/apply-promotion', requireModuleWrite('PAYMENTS'), async (req, res, next) => {
  const { gymId, userId, role } = getTenantContext(req);
  const { user_membership_id, promotion_id } = req.body;
  if (!user_membership_id) return res.status(400).json({ error: 'user_membership_id is required' });
  if (!promotion_id) return res.status(400).json({ error: 'promotion_id is required' });
  try {
    const result = await applyPromotionToMembership(
      gymId, userId, sourceForRole(role), Number(user_membership_id), Number(promotion_id),
    );
    recordAudit(req, { action: 'apply_promotion', entityType: 'user_membership', entityId: result.user_membership_id, next: result });
    res.status(201).json(result);
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// POST /payments/:id/receipt — generate (idempotent) and return a factura simplificada PDF.
// Only for payment_recorded events. Allocates a gapless receipt number on first call.
paymentsRouter.post('/:id/receipt', requireModuleWrite('PAYMENTS'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const eventId = parseInt(String(req.params.id), 10);
  if (!eventId) return res.status(400).json({ error: 'Invalid id' });

  try {
    const { rows: evRows } = await db.query<any>(
      `SELECT be.id, be.event_type, be.amount, be.receipt_number, be.receipt_issued_at,
              be.gym_id, be.charge_type_id, ct.code AS charge_type_code,
              m.name AS member_name
       FROM billing_events be
       LEFT JOIN charge_types ct ON ct.id = be.charge_type_id
       LEFT JOIN members m ON m.id = be.member_id
       WHERE be.id = ? AND be.gym_id = ?`,
      [eventId, gymId],
    );
    if (evRows.length === 0) return res.status(404).json({ error: 'Billing event not found' });
    const ev = evRows[0];
    if (ev.event_type !== 'payment_recorded') {
      return res.status(400).json({ error: 'Receipts can only be generated for payment_recorded events' });
    }
    if (!ev.amount || parseFloat(ev.amount) <= 0) {
      return res.status(400).json({ error: 'Billing event has no valid amount' });
    }

    const { rows: gymRows } = await db.query<any>(
      'SELECT id, name, legal_name, cif, fiscal_address, fiscal_phone FROM gyms WHERE id = ?',
      [gymId],
    );
    const gym = gymRows[0];

    // Fetch gym's system tax rate (is_system=1); fall back to 21% if none configured
    const { rows: taxRows } = await db.query<any>(
      "SELECT rate_percent AS rate FROM tax_rates WHERE gym_id = ? AND is_system = 1 AND status = 'active' LIMIT 1",
      [gymId],
    );
    const ivaRate = taxRows.length > 0 ? parseFloat(taxRows[0].rate) : 21;

    // Allocate receipt number if not yet issued
    let receiptNumber = ev.receipt_number as string | null;
    let issuedAt = ev.receipt_issued_at ? new Date(ev.receipt_issued_at) : null;

    if (!receiptNumber) {
      const year = new Date().getUTCFullYear();
      const newNumber = await db.transaction(async (tx) => {
        await tx.query(
          'INSERT IGNORE INTO receipt_sequences (gym_id, year, last_seq) VALUES (?, ?, 0)',
          [gymId, year],
        );
        await tx.query(
          'UPDATE receipt_sequences SET last_seq = last_seq + 1 WHERE gym_id = ? AND year = ?',
          [gymId, year],
        );
        const { rows } = await tx.query<{ last_seq: number }>(
          'SELECT last_seq FROM receipt_sequences WHERE gym_id = ? AND year = ?',
          [gymId, year],
        );
        const seq = rows[0].last_seq;
        const formatted = `${year}-${String(seq).padStart(4, '0')}`;
        const now = new Date();
        await tx.query(
          'UPDATE billing_events SET receipt_number = ?, receipt_issued_at = UTC_TIMESTAMP() WHERE id = ?',
          [formatted, eventId],
        );
        return { formatted, now };
      });
      receiptNumber = newNumber.formatted;
      issuedAt = newNumber.now;
      recordAudit(req, { action: 'issue_receipt', entityType: 'billing_event', entityId: eventId, next: { receipt_number: receiptNumber } });
    }

    const pdfBuffer = await generateReceiptPdf({
      receiptNumber,
      issuedAt: issuedAt!,
      gym: {
        name: gym.name,
        legalName: gym.legal_name,
        cif: gym.cif,
        fiscalAddress: gym.fiscal_address,
        fiscalPhone: gym.fiscal_phone,
      },
      memberName: ev.member_name ?? 'Socio',
      concept: ev.charge_type_code ?? 'membership_fee',
      totalAmount: parseFloat(ev.amount),
      ivaRate,
      currency: 'EUR',
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="recibo-${receiptNumber}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    next(err);
  }
});

// GET /payments/:id/receipt — download existing PDF (404 if not yet generated)
paymentsRouter.get('/:id/receipt', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const eventId = parseInt(String(req.params.id), 10);
  if (!eventId) return res.status(400).json({ error: 'Invalid id' });

  try {
    const { rows: evRows } = await db.query<any>(
      `SELECT be.id, be.event_type, be.amount, be.receipt_number, be.receipt_issued_at,
              ct.code AS charge_type_code, m.name AS member_name
       FROM billing_events be
       LEFT JOIN charge_types ct ON ct.id = be.charge_type_id
       LEFT JOIN members m ON m.id = be.member_id
       WHERE be.id = ? AND be.gym_id = ?`,
      [eventId, gymId],
    );
    if (evRows.length === 0) return res.status(404).json({ error: 'Billing event not found' });
    const ev = evRows[0];
    if (!ev.receipt_number) return res.status(404).json({ error: 'Receipt not yet generated' });

    const { rows: gymRows } = await db.query<any>(
      'SELECT id, name, legal_name, cif, fiscal_address, fiscal_phone FROM gyms WHERE id = ?',
      [gymId],
    );
    const gym = gymRows[0];
    const { rows: taxRows } = await db.query<any>(
      "SELECT rate_percent AS rate FROM tax_rates WHERE gym_id = ? AND is_system = 1 AND status = 'active' LIMIT 1",
      [gymId],
    );
    const ivaRate = taxRows.length > 0 ? parseFloat(taxRows[0].rate) : 21;

    const pdfBuffer = await generateReceiptPdf({
      receiptNumber: ev.receipt_number,
      issuedAt: new Date(ev.receipt_issued_at),
      gym: {
        name: gym.name,
        legalName: gym.legal_name,
        cif: gym.cif,
        fiscalAddress: gym.fiscal_address,
        fiscalPhone: gym.fiscal_phone,
      },
      memberName: ev.member_name ?? 'Socio',
      concept: ev.charge_type_code ?? 'membership_fee',
      totalAmount: parseFloat(ev.amount),
      ivaRate,
      currency: 'EUR',
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="recibo-${ev.receipt_number}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    next(err);
  }
});
