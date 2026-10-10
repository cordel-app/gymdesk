import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { resolveRequestActor } from '../domain/auditActor';
import { isDraftExpired } from '../domain/productSet';
import { resolveDeclinedBenefits } from './declined-plan-benefits';
import { effectivePrice } from './user-memberships';
import { resolveMemberId } from './me';
import { findLiveAssignmentsForMembers } from './one-active-plan';
import { activePlanConflictBody } from '../domain/oneActivePlan';
import {
  Actor, cancelInFlight, createDraft, submitForPayment,
} from './product-sets';
import {
  activateWithEvents, loadProductSetSimulationAssignment, snapshotProductSetFromPlan,
} from './product-set-configuration';
import {
  createProductSetCheckout, initialCharge, loadEditLock,
} from './product-set-checkout';

/**
 * #1325 PR 2d — the ProductSet-keyed commercial API.
 *
 *   GET    /product-sets?member_id=       a member's versions, newest first
 *   GET    /product-sets/edit-check?member_id=   what blocks editing (Q1)
 *   GET    /product-sets/:id              one version with what it froze
 *   POST   /product-sets                  start a Draft (409 while in flight or locked)
 *   POST   /product-sets/:id/save-and-pay Draft → Pending Payment + checkout
 *   POST   /product-sets/:id/activate     Draft → Active when nothing is owed
 *   DELETE /product-sets/:id              cancel an in-flight version
 *
 * Every transition is the server's: the lifecycle lives in `api/product-sets.ts`
 * and the editing lock is evaluated here, server-side, on creating a Draft and
 * again on committing it — the UI's pre-check is a courtesy.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const todayUtc = () => new Date().toISOString().slice(0, 10);

function actorOf(req: any): Actor {
  const ctx = getTenantContext(req);
  return {
    name: resolveRequestActor({
      actorName: ctx.actorName ?? null,
      impersonatedUserId: ctx.impersonatedUserId,
      impersonatedActorName: ctx.impersonatedActorName,
    }),
    type: ctx.impersonatedUserId ? 'superadmin' : 'staff',
  };
}

async function loadSet(gymId: string, id: unknown) {
  const numeric = Number(id);
  if (!Number.isInteger(numeric) || numeric <= 0) return null;
  const { rows } = await db.query<any>(
    `SELECT ps.*, (ps.last_activity_at < UTC_TIMESTAMP() - INTERVAL 120 MINUTE) AS stale
       FROM product_sets ps WHERE ps.id = ? AND ps.gym_id = ?`, [numeric, gymId]);
  return rows[0] ?? null;
}

function shape(row: any) {
  return {
    id: Number(row.id),
    owner_member_id: Number(row.owner_member_id),
    root_product_set_id: row.root_product_set_id != null ? Number(row.root_product_set_id) : null,
    previous_product_set_id: row.previous_product_set_id != null ? Number(row.previous_product_set_id) : null,
    version: Number(row.version),
    status: String(row.status),
    membership_plan_id: row.membership_plan_id != null ? Number(row.membership_plan_id) : null,
    starts_at: row.starts_at instanceof Date ? row.starts_at.toISOString().slice(0, 10) : String(row.starts_at).slice(0, 10),
    activated_at: row.activated_at ?? null,
    superseded_at: row.superseded_at ?? null,
    last_activity_at: row.last_activity_at ?? null,
    expired: row.status === 'draft' && Number(row.stale) === 1,
  };
}

export const productSetsRouter = Router({ mergeParams: true });

productSetsRouter.get('/edit-check', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const memberId = Number(req.query.member_id);
  if (!Number.isInteger(memberId) || memberId <= 0) return res.status(400).json({ error: 'member_id is required' });
  const blocking = await loadEditLock(gymId, memberId, todayUtc());
  res.json({ editable: blocking.length === 0, blocking });
});

productSetsRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const memberId = Number(req.query.member_id);
  if (!Number.isInteger(memberId) || memberId <= 0) return res.status(400).json({ error: 'member_id is required' });
  const { rows } = await db.query<any>(
    `SELECT ps.*, (ps.last_activity_at < UTC_TIMESTAMP() - INTERVAL 120 MINUTE) AS stale
       FROM product_sets ps WHERE ps.gym_id = ? AND ps.owner_member_id = ?
      ORDER BY ps.root_product_set_id, ps.version DESC`, [gymId, memberId]);
  res.json(rows.map(shape));
});

productSetsRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const set = await loadSet(gymId, req.params.id);
  if (!set) return res.status(404).json({ error: 'ProductSet not found' });
  const assignment = await loadProductSetSimulationAssignment(gymId, Number(set.id));
  const { rows: events } = await db.query<any>(
    `SELECT id, event_type, amount, billing_date, period_start, period_end, is_scheduled, schedule_id
       FROM billing_events WHERE gym_id = ? AND product_set_id = ? ORDER BY billing_date, id`,
    [gymId, Number(set.id)]);
  res.json({ ...shape(set), configuration: assignment, billing_events: events });
});

productSetsRouter.post('/', requireModuleWrite('PAYMENTS'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { member_id, membership_plan_id, starts_at, membership_fee_price } = req.body ?? {};
  const memberId = Number(member_id);
  if (!Number.isInteger(memberId) || memberId <= 0) return res.status(400).json({ error: 'member_id is required' });
  if (typeof starts_at !== 'string' || !DATE_RE.test(starts_at)) return res.status(400).json({ error: 'starts_at must be YYYY-MM-DD' });
  const planId = membership_plan_id == null || membership_plan_id === '' ? null : Number(membership_plan_id);
  if (planId !== null && (!Number.isInteger(planId) || planId <= 0)) return res.status(400).json({ error: 'membership_plan_id must be a positive integer' });

  const { rows: memberRows } = await db.query('SELECT id FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL', [memberId, gymId]);
  if (memberRows.length === 0) return res.status(404).json({ error: 'Member not found' });

  let fee: number | null = null;
  let declined: Array<{ section: string; product_id: number }> = [];
  if (planId !== null) {
    const eff = await effectivePrice(planId, gymId, starts_at);
    if (!eff) return res.status(404).json({ error: 'Plan not found' });
    const parsed = membership_fee_price != null && membership_fee_price !== '' ? Number(membership_fee_price) : eff.price;
    if (!Number.isFinite(parsed) || parsed < 0) return res.status(400).json({ error: 'membership_fee_price must be a non-negative number' });
    fee = parsed;
    const resolved = await resolveDeclinedBenefits(gymId, planId, req.body?.declined_benefits);
    if (resolved.error !== undefined) return res.status(400).json({ error: resolved.error });
    declined = resolved.declined ?? [];
  }

  // #956: a Member holds zero or one Membership Plan. A version that carries a
  // plan may not be created for a Member who is already on one — their own
  // legacy assignment, or somebody else's plan that covers them. The one
  // assignment that is *not* a conflict is the one this owner's own Active
  // version projects: a new version of their own chain replaces it by design.
  // No `confirm` exists here — replacing is a new version, never an overwrite.
  if (planId !== null) {
    const { rows: own } = await db.query<{ user_membership_id: number | null }>(
      `SELECT user_membership_id FROM product_sets
        WHERE gym_id = ? AND owner_member_id = ? AND status = 'active' LIMIT 1`, [gymId, memberId]);
    const ownUmId = own[0]?.user_membership_id != null ? Number(own[0].user_membership_id) : null;
    const conflicts = await findLiveAssignmentsForMembers(db, gymId, [memberId],
      ownUmId != null ? { excludeUserMembershipId: ownUmId } : {});
    if (conflicts.length > 0) {
      const { rows: planRows } = await db.query<{ name: string }>(
        'SELECT name FROM membership_plans WHERE id = ? AND gym_id = ?', [planId, gymId]);
      return res.status(409).json(activePlanConflictBody(conflicts, planRows[0]?.name ?? null));
    }
  }

  // Q1: an unresolved past obligation of the active configuration blocks a new
  // version — enforced here, not only by the editor that opened the page.
  const blocking = await loadEditLock(gymId, memberId, todayUtc());
  if (blocking.length > 0) {
    return res.status(409).json({
      error: 'edit_locked',
      message: 'The ProductSet cannot be modified until its unresolved Billing Events are resolved.',
      blocking,
    });
  }

  const out = await db.transaction(async (tx) => {
    const draft = await createDraft(tx, { gymId, ownerMemberId: memberId, membershipPlanId: planId, startsAt: starts_at, actor: actorOf(req) });
    if (draft.kind !== 'created') return draft;
    if (planId !== null) {
      await snapshotProductSetFromPlan(tx, {
        gymId, productSetId: draft.productSet.id, membershipPlanId: planId,
        membershipFeePrice: fee, startsAt: starts_at, declinedBenefits: declined,
      });
    }
    return draft;
  });
  if (out.kind === 'in_flight') {
    return res.status(409).json({ error: 'in_flight', product_set_id: out.productSetId, status: out.status });
  }
  recordAudit(req, { action: 'create', entityType: 'product_set', entityId: out.productSet.id, next: out.productSet });
  const row = await loadSet(gymId, out.productSet.id);
  res.status(201).json(shape(row));
});

productSetsRouter.post('/:id/save-and-pay', requireModuleWrite('PAYMENTS'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const set = await loadSet(gymId, req.params.id);
  if (!set) return res.status(404).json({ error: 'ProductSet not found' });
  if (set.status === 'draft' && Number(set.stale) === 1) return res.status(410).json({ error: 'draft_expired' });
  if (set.status !== 'draft' && set.status !== 'pending_payment') {
    return res.status(409).json({ error: 'not_committable', status: set.status });
  }
  const blocking = await loadEditLock(gymId, Number(set.owner_member_id), todayUtc());
  if (blocking.length > 0) return res.status(409).json({ error: 'edit_locked', blocking });

  const startsAt = (set.starts_at instanceof Date ? set.starts_at.toISOString() : String(set.starts_at)).slice(0, 10);
  const charge = await initialCharge(gymId, Number(set.id), startsAt);
  if (!charge || charge.amount <= 0) {
    return res.status(409).json({ error: 'nothing_to_pay', message: 'No initial payment is owed; activate the ProductSet instead.' });
  }

  if (set.status === 'draft') {
    const moved = await db.transaction((tx) => submitForPayment(tx, gymId, Number(set.id)));
    if (moved.kind !== 'ok') return res.status(409).json({ error: moved.kind });
  }
  const { rows: m } = await db.query<{ email: string | null }>('SELECT email FROM members WHERE id = ? AND gym_id = ?', [set.owner_member_id, gymId]);
  const checkout = await createProductSetCheckout({
    gymId, productSetId: Number(set.id), memberId: Number(set.owner_member_id),
    memberEmail: m[0]?.email ?? '', startsAt, charge,
  });
  recordAudit(req, { action: 'save_and_pay', entityType: 'product_set', entityId: set.id, next: { status: 'pending_payment' } });
  res.status(201).json({
    product_set_id: Number(set.id), status: 'pending_payment',
    payment_request_id: checkout.paymentRequestId, billing_event_id: checkout.billingEventId,
    checkout_url: checkout.checkoutUrl, amount: charge.amount,
  });
});

productSetsRouter.post('/:id/activate', requireModuleWrite('PAYMENTS'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const set = await loadSet(gymId, req.params.id);
  if (!set) return res.status(404).json({ error: 'ProductSet not found' });
  if (set.status !== 'draft') return res.status(409).json({ error: 'not_committable', status: set.status });
  if (Number(set.stale) === 1) return res.status(410).json({ error: 'draft_expired' });

  const startsAt = (set.starts_at instanceof Date ? set.starts_at.toISOString() : String(set.starts_at)).slice(0, 10);
  const charge = await initialCharge(gymId, Number(set.id), startsAt);
  if (charge && charge.amount > 0) {
    return res.status(409).json({ error: 'payment_required', amount: charge.amount, message: 'An initial payment is owed; use save-and-pay.' });
  }
  const blocking = await loadEditLock(gymId, Number(set.owner_member_id), todayUtc());
  if (blocking.length > 0) return res.status(409).json({ error: 'edit_locked', blocking });

  const out = await db.transaction((tx) => activateWithEvents(tx, { gymId, productSetId: Number(set.id), today: todayUtc() }));
  if (out.kind !== 'ok') return res.status(409).json({ error: out.kind });
  recordAudit(req, { action: 'activate', entityType: 'product_set', entityId: set.id, next: { status: 'active' } });
  res.json({ product_set_id: Number(set.id), status: 'active', events_created: (out as any).eventsCreated ?? 0 });
});

/**
 * A first payment taken in cash: recorded as a request of method `cash` (no
 * provider attempt) on the version's initial event, which settles it, and the
 * version is activated in the same transaction. Only a `pending_payment` set —
 * Save & Pay wrote the event — and only once.
 */
productSetsRouter.post('/:id/record-payment', requireModuleWrite('PAYMENTS'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const set = await loadSet(gymId, req.params.id);
  if (!set) return res.status(404).json({ error: 'ProductSet not found' });
  if (set.status !== 'pending_payment') return res.status(409).json({ error: 'not_pending_payment', status: set.status });

  const { rows: ct } = await db.query<{ id: number }>("SELECT id FROM charge_types WHERE code = 'membership_fee' LIMIT 1");
  const out = await db.transaction(async (tx) => {
    const { rows: ev } = await tx.query<{ id: number; amount: string }>(
      `SELECT be.id, be.amount FROM billing_events be
        WHERE be.gym_id = ? AND be.product_set_id = ? AND be.event_type = 'payment_recorded'
          AND NOT EXISTS (SELECT 1 FROM payment_requests pr WHERE pr.billing_event_id = be.id AND pr.status = 'completed')
        ORDER BY be.id DESC LIMIT 1 FOR UPDATE`,
      [gymId, Number(set.id)]);
    if (!ev[0]) return { kind: 'no_open_event' as const };
    const { rows: prev } = await tx.query<{ n: number }>(
      'SELECT COALESCE(MAX(attempt), 0) AS n FROM payment_requests WHERE billing_event_id = ?', [ev[0].id]);
    await tx.query(
      `INSERT INTO payment_requests
         (gym_id, member_id, amount, currency, charge_type_id, billing_event_id, status, provider,
          source, attempt, method, initiated_by, created_at, completed_at)
       VALUES (?, ?, ?, 'EUR', ?, ?, 'completed', 'monei', 'manual', ?, 'cash', ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
      [gymId, Number(set.owner_member_id), ev[0].amount, ct[0]?.id ?? null, ev[0].id,
        Number(prev[0]?.n ?? 0) + 1, getTenantContext(req).userId ?? null]);
    const activated = await activateWithEvents(tx, { gymId, productSetId: Number(set.id), today: todayUtc() });
    return { kind: activated.kind, billingEventId: Number(ev[0].id) };
  });
  if (out.kind === 'no_open_event') return res.status(409).json({ error: 'no_open_event' });
  if (out.kind !== 'ok') return res.status(409).json({ error: out.kind });
  recordAudit(req, { action: 'record_payment', entityType: 'product_set', entityId: set.id, next: { status: 'active', method: 'cash' } });
  res.json({ product_set_id: Number(set.id), status: 'active', billing_event_id: out.billingEventId });
});

productSetsRouter.delete('/:id', requireModuleWrite('PAYMENTS'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const set = await loadSet(gymId, req.params.id);
  if (!set) return res.status(404).json({ error: 'ProductSet not found' });
  if (set.status === 'pending_payment') {
    // A cancelled checkout takes its initial event and attempts with it, which
    // `cancelInFlight` only allows when no payment can still settle.
    const result = await db.transaction(async (tx) => {
      const { rows: events } = await tx.query<{ id: number }>(
        `SELECT id FROM billing_events WHERE gym_id = ? AND product_set_id = ? FOR UPDATE`, [gymId, Number(set.id)]);
      const { rows: attempts } = await tx.query<{ provider_ref: string | null; provider_status: string | null; status: string }>(
        `SELECT provider_ref, provider_status, status FROM payment_requests
          WHERE gym_id = ? AND billing_event_id IN (SELECT id FROM billing_events WHERE product_set_id = ?)`,
        [gymId, Number(set.id)]);
      const { canCancelPending } = await import('../domain/productSet');
      const ok = canCancelPending(attempts.map((a) => ({
        providerRef: a.provider_ref, providerStatus: a.provider_status, status: a.status,
      })));
      if (!ok) return { kind: 'unresolved' as const };
      if (events.length > 0) {
        await tx.query(
          `DELETE FROM payment_requests WHERE gym_id = ? AND billing_event_id IN (${events.map(() => '?').join(',')})`,
          [gymId, ...events.map((e) => e.id)]);
        await tx.query(
          `DELETE FROM billing_events WHERE gym_id = ? AND id IN (${events.map(() => '?').join(',')})`,
          [gymId, ...events.map((e) => e.id)]);
      }
      return cancelInFlight(tx, gymId, Number(set.id));
    });
    if (result.kind === 'unresolved') {
      return res.status(409).json({ error: 'payment_unresolved', message: 'A payment for this ProductSet is still unresolved.' });
    }
    if (result.kind !== 'cancelled') return res.status(409).json({ error: result.kind });
  } else {
    const result = await db.transaction((tx) => cancelInFlight(tx, gymId, Number(set.id)));
    if (result.kind !== 'cancelled') return res.status(409).json({ error: result.kind, status: (result as any).status });
  }
  recordAudit(req, { action: 'cancel', entityType: 'product_set', entityId: set.id });
  res.status(204).end();
});

/** The member's own versions — never named by the request (#1036). */
export const meProductSetsRouter = Router();
meProductSetsRouter.get('/', async (req, res) => {
  const ctx = getTenantContext(req);
  let memberId: number;
  try { memberId = await resolveMemberId(ctx.gymId, ctx); } catch { return res.json([]); }
  const { rows } = await db.query<any>(
    `SELECT ps.*, (ps.last_activity_at < UTC_TIMESTAMP() - INTERVAL 120 MINUTE) AS stale
       FROM product_sets ps
      WHERE ps.gym_id = ? AND ps.owner_member_id = ?
         OR ps.root_product_set_id IN (SELECT root_product_set_id FROM product_set_members WHERE gym_id = ? AND member_id = ?)
      ORDER BY ps.root_product_set_id, ps.version DESC`,
    [ctx.gymId, memberId, ctx.gymId, memberId]);
  res.json(rows.filter((r) => r.status !== 'draft' || Number(r.owner_member_id) === memberId).map(shape));
});

export { isDraftExpired };
