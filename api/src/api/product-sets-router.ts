import { Router } from 'express';
import { db, type Tx } from '../infra/db';
import { recordStatusChange } from './billing-events';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { resolveRequestActor } from '../domain/auditActor';
import { canCancelPending, isDraftExpired } from '../domain/productSet';
import { resolveDeclinedBenefits } from './declined-plan-benefits';
import { effectivePrice } from './user-memberships';
import { resolveMemberId } from './me';
import { productSetDraftRouter } from './product-set-draft-router';
import { findLiveAssignmentsForMembers } from './one-active-plan';
import { activePlanConflictBody, addPlanUnsupportedBody, parseConflictResolution } from '../domain/oneActivePlan';
import {
  Actor, cancelInFlight, createDraft, returnPendingToDraft, submitForPayment,
} from './product-sets';
import { ensureRecurringDraft } from './recurring-purchase-draft';
import { diffConfigurations } from '../domain/productSetDiff';
import {
  activateWithEvents, loadProductSetSimulationAssignment, snapshotProductSetFromPlan,
} from './product-set-configuration';
import {
  createProductSetCheckout, ensureInitialEvent, commitCharge, loadEditLock,
} from './product-set-checkout';
import { methodAvailability, payFlowFor } from '../domain/productSetPayment';
import { chargeGuard, EarlierAttempt } from '../domain/chargeGuard';
import { classifyProviderStatus, normaliseProviderStatus } from '../domain/providerPaymentStatus';
import { getPaymentProvider } from '../payments';
import { toMinorUnits } from '../payments/money';
import { getRequestLocale } from '../infra/locale';
import crypto from 'crypto';

/**
 * #1325 PR 2d — the ProductSet-keyed commercial API.
 *
 *   GET    /product-sets?member_id=       a member's versions, newest first
 *   GET    /product-sets/edit-check?member_id=   what blocks editing (Q1)
 *   GET    /product-sets/:id              one version with what it froze
 *   POST   /product-sets                  start a Draft (409 while in flight or locked)
 *   POST   /product-sets/draft            #1537 — the member's recurring Draft, created on first use (idempotent)
 *   GET    /product-sets/:id/review       #1537 — diff vs the Active version + the amount due today
 *   POST   /product-sets/:id/save-and-pay Draft → Pending Payment + checkout
 *   POST   /product-sets/:id/pay          #1664 — Save & Pay with a chosen method (members_app | cash | card | monei)
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

// The Draft's configuration (sections, Billing & Duration, fee, services,
// Promotions, coverage, forecast) — registered after the fixed paths below it
// would shadow, so only `/:id/<segment>` reaches it.

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
  // #2125: `on_conflict: 'add'` is the staff answer "keep what they have and add this
  // beside it", so the check stands aside for it; anything else still answers the 409
  // the Add-or-Replace modal is built from.
  if (planId !== null && parseConflictResolution(req.body) === 'add') {
    // #2125 stage 4: this route versions the owner's own chain, so 'add' beside its plan is refused.
    const { rows: ownPlan } = await db.query(
      `SELECT 1 FROM product_sets WHERE gym_id = ? AND owner_member_id = ? AND status = 'active'
          AND membership_plan_id IS NOT NULL LIMIT 1`, [gymId, memberId]);
    if (ownPlan.length > 0) return res.status(409).json(addPlanUnsupportedBody());
  }
  if (planId !== null && parseConflictResolution(req.body) !== 'add') {
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
        membershipFeePrice: fee, startsAt: starts_at, declinedBenefits: declined, origin: 'admin',
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

/** `draft → pending_payment` for the assignment a version projects, audited as
 * every assignment status transition is. A row in any other status is left
 * alone (the assignment-side Save & Pay moves its own row first). */
async function syncLinkedAssignmentToPendingPayment(tx: Tx, gymId: string, userMembershipId: number, actor: string | null) {
  const { rows } = await tx.query<{ member_id: number }>(
    `SELECT member_id FROM user_memberships WHERE id = ? AND gym_id = ? AND status = 'draft' FOR UPDATE`,
    [userMembershipId, gymId],
  );
  if (!rows[0]) return;
  await tx.query(
    `UPDATE user_memberships SET status = 'pending_payment', modified_at = UTC_TIMESTAMP(), modified_by = ?
      WHERE id = ? AND gym_id = ? AND status = 'draft'`,
    [actor, userMembershipId, gymId],
  );
  await recordStatusChange(tx, {
    gymId, userMembershipId, memberId: Number(rows[0].member_id),
    previousStatus: 'draft', newStatus: 'pending_payment', source: 'admin', actorUserId: null,
  });
}

async function saveAndPayHandler(req: any, res: any) {
  const { gymId } = getTenantContext(req);
  const set = await loadSet(gymId, req.params.id);
  if (!set) return res.status(404).json({ error: 'ProductSet not found' });
  if (set.status === 'draft' && Number(set.stale) === 1) return res.status(410).json({ error: 'draft_expired' });
  if (set.status !== 'draft' && set.status !== 'pending_payment') {
    return res.status(409).json({ error: 'not_committable', status: set.status });
  }
  const blocking = await loadEditLock(gymId, Number(set.owner_member_id), todayUtc());
  if (blocking.length > 0) return res.status(409).json({ error: 'edit_locked', blocking });

  // #1521: a version that replaces a running one owes only what is new, dated
  // today — never the plan's first cycle again.
  const { startsAt, charge } = await commitCharge(gymId, set);
  if (!charge || charge.amount <= 0) {
    return res.status(409).json({ error: 'nothing_to_pay', message: 'No initial payment is owed; activate the ProductSet instead.' });
  }

  if (set.status === 'draft') {
    const moved = await db.transaction(async (tx) => {
      const out = await submitForPayment(tx, gymId, Number(set.id));
      // The Admin's Draft assignment is a cache of this version (#1325 PR
      // 3e-1), so it moves with it: left `draft`, the Member card's plan row
      // read Draft beside a PS status of Pending Payment.
      if (out.kind === 'ok' && set.user_membership_id != null) {
        await syncLinkedAssignmentToPendingPayment(tx, gymId, Number(set.user_membership_id), actorOf(req).name);
      }
      return out;
    });
    if (moved.kind !== 'ok') return res.status(409).json({ error: moved.kind });
  }
  const { rows: m } = await db.query<{ email: string | null }>('SELECT email FROM members WHERE id = ? AND gym_id = ?', [set.owner_member_id, gymId]);
  const checkout = await createProductSetCheckout({
    gymId, productSetId: Number(set.id), memberId: Number(set.owner_member_id),
    memberEmail: m[0]?.email ?? '', startsAt, charge, actor: actorOf(req).name,
  });
  recordAudit(req, { action: 'save_and_pay', entityType: 'product_set', entityId: set.id, next: { status: 'pending_payment' } });
  res.status(201).json({
    product_set_id: Number(set.id), status: 'pending_payment',
    payment_request_id: checkout.paymentRequestId, billing_event_id: checkout.billingEventId,
    checkout_url: checkout.checkoutUrl, amount: charge.amount,
  });
}
productSetsRouter.post('/:id/save-and-pay', requireModuleWrite('PAYMENTS'), saveAndPayHandler);

productSetsRouter.post('/:id/activate', requireModuleWrite('PAYMENTS'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const set = await loadSet(gymId, req.params.id);
  if (!set) return res.status(404).json({ error: 'ProductSet not found' });
  if (set.status !== 'draft') return res.status(409).json({ error: 'not_committable', status: set.status });
  if (Number(set.stale) === 1) return res.status(410).json({ error: 'draft_expired' });

  // #1537: the same delta Save & Pay would charge, so a replacement that adds
  // nothing owed activates here instead of being asked for a plan's first cycle.
  const { charge } = await commitCharge(gymId, set);
  if (charge && charge.amount > 0) {
    return res.status(409).json({ error: 'payment_required', amount: charge.amount, message: 'An initial payment is owed; use save-and-pay.' });
  }
  const blocking = await loadEditLock(gymId, Number(set.owner_member_id), todayUtc());
  if (blocking.length > 0) return res.status(409).json({ error: 'edit_locked', blocking });

  const out = await db.transaction((tx) => activateWithEvents(tx, { gymId, productSetId: Number(set.id), today: todayUtc(), actor: actorOf(req).name }));
  if (out.kind !== 'ok') return res.status(409).json({ error: out.kind });
  recordAudit(req, { action: 'activate', entityType: 'product_set', entityId: set.id, next: { status: 'active' } });
  res.json({ product_set_id: Number(set.id), status: 'active', events_created: (out as any).eventsCreated ?? 0 });
});

/**
 * #1664 — Save & Pay with the method staff chose in the confirmation modal.
 *
 *   members_app  the existing Save & Pay: Pending Payment + a hosted checkout
 *   cash / card  staff-confirmed money: the version, its first event and a
 *                completed `cash` / `card_terminal` attempt commit in ONE
 *                transaction and the version activates; no provider call
 *   monei        the member's stored token is charged for the first event; the
 *                version activates only when the provider SETTLES it
 *
 * Until this call the version is a Draft; a second submission finds it past
 * `draft` under the row lock and is refused, so it cannot pay twice.
 */
productSetsRouter.post('/:id/pay', requireModuleWrite('PAYMENTS'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    const code = String(req.body?.method ?? '');
    const flow = payFlowFor(code);
    if (!flow) return res.status(400).json({ error: 'unsupported_payment_method' });
    const { rows: cat } = await db.query<{ id: number }>(
      "SELECT id FROM base_payment_methods WHERE code = ? AND status = 'active' AND deleted_at IS NULL", [code]);
    if (!cat[0]) return res.status(409).json({ error: 'payment_method_inactive' });

    if (flow.flow === 'members_app') return saveAndPayHandler(req, res);

    const set = await loadSet(gymId, req.params.id);
    if (!set) return res.status(404).json({ error: 'ProductSet not found' });
    if (set.status === 'draft' && Number(set.stale) === 1) return res.status(410).json({ error: 'draft_expired' });
    if (set.status !== 'draft') return res.status(409).json({ error: 'not_committable', status: set.status });
    const memberId = Number(set.owner_member_id);
    const blocking = await loadEditLock(gymId, memberId, todayUtc());
    if (blocking.length > 0) return res.status(409).json({ error: 'edit_locked', blocking });

    const { startsAt, charge } = await commitCharge(gymId, set);
    if (!charge || charge.amount <= 0) return res.status(409).json({ error: 'nothing_to_pay' });
    const actor = actorOf(req).name;
    const { rows: ct } = await db.query<{ id: number }>("SELECT id FROM charge_types WHERE code = 'membership_fee' LIMIT 1");
    const chargeTypeId = ct[0]?.id ?? null;

    let token: { payment_token: string; sequence_id: string; provider: string | null } | null = null;
    if (flow.flow === 'monei') {
      const { rows: pm } = await db.query<any>(
        `SELECT payment_token, sequence_id, provider FROM payment_methods
          WHERE gym_id = ? AND member_id = ? AND payment_token IS NOT NULL AND sequence_id IS NOT NULL
          ORDER BY COALESCE(updated_at, created_at) DESC, id DESC LIMIT 1`, [gymId, memberId]);
      if (!pm[0]) return res.status(409).json({ error: 'monei_token_missing', message: 'This member does not have a Monei payment token.' });
      token = pm[0];
    }

    const orderId = `PS-${String(gymId).slice(0, 8)}-${set.id}-${crypto.randomUUID().slice(0, 8)}`;
    const staged = await db.transaction(async (tx) => {
      const { rows: locked } = await tx.query<{ status: string }>(
        'SELECT status FROM product_sets WHERE id = ? AND gym_id = ? FOR UPDATE', [Number(set.id), gymId]);
      if (locked[0]?.status !== 'draft') return { kind: 'not_committable' as const, status: locked[0]?.status };
      const moved = await submitForPayment(tx, gymId, Number(set.id));
      if (moved.kind !== 'ok') return { kind: moved.kind };
      const eventId = await ensureInitialEvent(tx, { gymId, productSetId: Number(set.id), memberId, startsAt, charge, chargeTypeId, actor });
      const { rows: prev } = await tx.query<any>(
        'SELECT id, method, provider_status, provider_ref, status, attempt FROM payment_requests WHERE billing_event_id = ? FOR UPDATE', [eventId]);
      const guard = chargeGuard(prev.map((a: any): EarlierAttempt => ({
        id: Number(a.id), method: a.method, providerStatus: a.provider_status, providerRef: a.provider_ref, status: a.status,
      })));
      if (!guard.allowed) return { kind: 'charge_refused' as const, reason: guard.reason };
      const attempt = prev.reduce((m: number, a: any) => Math.max(m, Number(a.attempt)), 0) + 1;
      const done = flow.flow === 'manual';
      const { insertId } = await tx.query(
        `INSERT INTO payment_requests
           (gym_id, member_id, amount, currency, charge_type_id, billing_event_id, status, provider,
            provider_order, source, attempt, method, created_by, created_at${done ? ', completed_at' : ''})
         VALUES (?, ?, ?, 'EUR', ?, ?, ?, ?, ?, 'manual', ?, ?, ?, UTC_TIMESTAMP()${done ? ', UTC_TIMESTAMP()' : ''})`,
        [gymId, memberId, charge.amount.toFixed(2), chargeTypeId, eventId, done ? 'completed' : 'pending',
          token?.provider ?? 'monei', orderId, attempt, done ? flow.attemptMethod : 'provider', actor]);
      await tx.query('UPDATE product_sets SET payment_request_id = ? WHERE id = ?', [insertId, Number(set.id)]);
      if (done) {
        const activated = await activateWithEvents(tx, { gymId, productSetId: Number(set.id), today: todayUtc(), actor });
        if (activated.kind !== 'ok') throw Object.assign(new Error(activated.kind), { kind: activated.kind });
      }
      return { kind: 'ok' as const, eventId, attemptId: Number(insertId) };
    }).catch((err: any) => (err?.kind ? { kind: String(err.kind) } : Promise.reject(err)));
    if (staged.kind !== 'ok') return res.status(409).json({ error: staged.kind, ...(staged as any) });
    const { eventId, attemptId } = staged as { eventId: number; attemptId: number };

    if (flow.flow === 'manual') {
      recordAudit(req, { action: 'save_and_pay', entityType: 'product_set', entityId: set.id, next: { status: 'active', method: code } });
      return res.status(201).json({ product_set_id: Number(set.id), status: 'active', outcome: 'paid', billing_event_id: eventId, amount: charge.amount });
    }

    // Monei — the provider is called outside any transaction; the attempt row exists first.
    let outcome: 'paid' | 'failed' | 'pending' | 'unknown' = 'unknown';
    try {
      const result = await getPaymentProvider().executeRecurring({
        orderId, amount: toMinorUnits(charge.amount), currency: 'EUR',
        paymentToken: token!.payment_token, sequenceId: token!.sequence_id,
      });
      const raw = normaliseProviderStatus(result.providerStatus ?? (result.success ? 'SUCCEEDED' : 'FAILED'));
      const cls = classifyProviderStatus(raw);
      const settled = result.success === true && cls === 'settled';
      const internal = settled ? 'completed' : cls === 'in_flight' ? 'pending' : 'failed';
      await db.transaction(async (tx) => {
        await tx.query(
          `UPDATE payment_requests SET status = ?, provider_ref = ?, provider_status = ?, failure_code = ?, failure_message = ?,
                  completed_at = ${internal === 'completed' ? 'UTC_TIMESTAMP()' : 'NULL'}, modified_at = UTC_TIMESTAMP(), modified_by = ?
            WHERE id = ?`,
          [internal, result.providerRef ?? null, raw, result.errorCode ?? null, result.errorMessage?.slice(0, 500) ?? null, actor, attemptId]);
        if (internal === 'completed') {
          const a = await activateWithEvents(tx, { gymId, productSetId: Number(set.id), today: todayUtc(), actor });
          if (a.kind !== 'ok') throw new Error(a.kind);
        }
      });
      outcome = internal === 'completed' ? 'paid' : internal === 'pending' ? 'pending' : 'failed';
    } catch {
      // Provider threw or never answered: the attempt stays pending with no provider status —
      // an unknown outcome the charge guard treats as unresolved. Never reported as paid.
      outcome = 'unknown';
    }
    recordAudit(req, { action: 'save_and_pay', entityType: 'product_set', entityId: set.id, next: { status: outcome === 'paid' ? 'active' : 'pending_payment', method: code, outcome } });
    res.status(outcome === 'paid' ? 201 : 202).json({
      product_set_id: Number(set.id), status: outcome === 'paid' ? 'active' : 'pending_payment',
      outcome, billing_event_id: eventId, amount: charge.amount,
    });
  } catch (err) { next(err); }
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
          source, attempt, method, created_by, created_at, completed_at)
       VALUES (?, ?, ?, 'EUR', ?, ?, 'completed', 'monei', 'manual', ?, 'cash', ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
      [gymId, Number(set.owner_member_id), ev[0].amount, ct[0]?.id ?? null, ev[0].id,
        Number(prev[0]?.n ?? 0) + 1, actorOf(req).name]);
    const activated = await activateWithEvents(tx, { gymId, productSetId: Number(set.id), today: todayUtc(), actor: actorOf(req).name });
    return { kind: activated.kind, billingEventId: Number(ev[0].id) };
  });
  if (out.kind === 'no_open_event') return res.status(409).json({ error: 'no_open_event' });
  if (out.kind !== 'ok') return res.status(409).json({ error: out.kind });
  recordAudit(req, { action: 'record_payment', entityType: 'product_set', entityId: set.id, next: { status: 'active', method: 'cash' } });
  res.json({ product_set_id: Number(set.id), status: 'active', billing_event_id: out.billingEventId });
});

/**
 * Cancels an in-flight version. A Draft is deleted; a Pending Payment checkout
 * returns to Draft (its initial event and attempts removed) only while `canCancelPending()` says every attempt
 * is definitively unsuccessful or none was ever submitted (#1535): a submitted
 * attempt with no provider status is an unknown outcome and a paid one is
 * money received, so both answer `payment_unresolved` and nothing is touched.
 */
async function cancelCheckout(gymId: string, set: any) {
  if (set.status !== 'pending_payment') {
    return db.transaction((tx) => cancelInFlight(tx, gymId, Number(set.id)));
  }
  // #1991 stage 4: a cancelled checkout returns to the Draft it was saved from.
  return db.transaction((tx) => returnPendingToDraft(tx, gymId, Number(set.id)));
}

function cancelFailure(result: { kind: string; status?: string }) {
  if (result.kind === 'unresolved') {
    return { error: 'payment_unresolved', message: 'A payment for this ProductSet is still unresolved.' };
  }
  return { error: result.kind, status: result.status };
}

productSetsRouter.delete('/:id', requireModuleWrite('PAYMENTS'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const set = await loadSet(gymId, req.params.id);
  if (!set) return res.status(404).json({ error: 'ProductSet not found' });
  const result = await cancelCheckout(gymId, set);
  if (result.kind !== 'cancelled') return res.status(409).json(cancelFailure(result));
  recordAudit(req, { action: 'cancel', entityType: 'product_set', entityId: set.id });
  res.status(204).end();
});

/**
 * #1537 — the member's recurring-configuration Draft, created on the first
 * edit and the same row on every later one. Idempotent: no "create draft" step
 * exists, a Pending Payment version answers `409 in_flight` (never a second
 * Draft, never a second charge) and the editing lock is the server's.
 */
productSetsRouter.post('/draft', requireModuleWrite('PAYMENTS'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const memberId = Number(req.body?.member_id);
  if (!Number.isInteger(memberId) || memberId <= 0) return res.status(400).json({ error: 'member_id is required' });
  try {
    const { rows: memberRows } = await db.query('SELECT id FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL', [memberId, gymId]);
    if (memberRows.length === 0) return res.status(404).json({ error: 'Member not found' });

    const blocking = await loadEditLock(gymId, memberId, todayUtc());
    if (blocking.length > 0) return res.status(409).json({ error: 'edit_locked', blocking });

    const out = await db.transaction((tx) => ensureRecurringDraft(tx, {
      gymId, memberId, actor: actorOf(req), today: todayUtc(),
    }));
    if (out.kind === 'in_flight') {
      return res.status(409).json({ error: 'in_flight', product_set_id: out.productSetId, status: out.status });
    }
    if (out.created) {
      recordAudit(req, { action: 'create', entityType: 'product_set', entityId: out.productSetId, next: { auto_draft: true } });
    }
    const row = await loadSet(gymId, out.productSetId);
    res.status(out.created ? 201 : 200).json({ ...shape(row), created: out.created });
  } catch (err) { next(err); }
});

/**
 * #1537 — "Review your changes": the differences between the Active version and
 * this Draft, and what committing it asks for today. Read-only — it writes no
 * Billing Event, request or version, and it takes its amount from the very
 * function `save-and-pay` charges from. `amount_due: null` with an `error` means
 * it could not be established reliably and the screen must not offer Confirm.
 */
productSetsRouter.get('/:id/review', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    const set = await loadSet(gymId, req.params.id);
    if (!set) return res.status(404).json({ error: 'ProductSet not found' });
    if (set.status !== 'draft' && set.status !== 'pending_payment') {
      return res.status(409).json({ error: 'not_committable', status: set.status });
    }
    if (set.status === 'draft' && Number(set.stale) === 1) return res.status(410).json({ error: 'draft_expired' });

    const after = await loadProductSetSimulationAssignment(gymId, Number(set.id));
    const before = set.previous_product_set_id != null
      ? await loadProductSetSimulationAssignment(gymId, Number(set.previous_product_set_id))
      : null;
    if (!after) return res.status(404).json({ error: 'ProductSet not found' });
    const changes = diffConfigurations(before, after);

    let amountDue: number | null = null;
    let lines: any[] = [];
    let error: string | null = null;
    try {
      const blocking = await loadEditLock(gymId, Number(set.owner_member_id), todayUtc());
      if (blocking.length > 0) {
        error = 'edit_locked';
      } else {
        const { charge } = await commitCharge(gymId, set);
        amountDue = charge ? Math.round(charge.amount * 100) / 100 : 0;
        lines = (charge?.lines ?? []).map((l: any) => ({
          item_name: l.item_name ?? null, quantity: Number(l.quantity), amount: Number(l.amount),
          regular_unit_price: l.regular_unit_price != null ? Number(l.regular_unit_price) : null,
          promotion_name: l.promotion_name ?? null,
          treatment_action: l.treatment_action ?? null,
          treatment_value: l.treatment_value != null ? Number(l.treatment_value) : null,
          tax_rate_percent: l.tax_rate_percent != null ? Number(l.tax_rate_percent) : null,
          amount_excl_tax: l.amount_excl_tax != null ? Number(l.amount_excl_tax) : null,
        }));
        if (!Number.isFinite(amountDue) || amountDue < 0) { amountDue = null; error = 'amount_unavailable'; }
      }
    } catch {
      amountDue = null;
      error = 'amount_unavailable';
    }

    const { rows: tok } = await db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM payment_methods WHERE gym_id = ? AND member_id = ? AND payment_token IS NOT NULL AND sequence_id IS NOT NULL',
      [gymId, Number(set.owner_member_id)]);
    const hasMoneiToken = Number(tok[0]?.n ?? 0) > 0;
    const locale = getRequestLocale(req);
    const { rows: methods } = await db.query<any>(
      `SELECT m.code,
              COALESCE((SELECT t.name FROM base_payment_method_translations t WHERE t.base_payment_method_id = m.id AND t.locale = ?),
                       (SELECT t.name FROM base_payment_method_translations t WHERE t.base_payment_method_id = m.id AND t.locale = 'en'),
                       m.code) AS name
         FROM base_payment_methods m
        WHERE m.status = 'active' AND m.deleted_at IS NULL ORDER BY m.id`, [locale]);
    const paymentMethods = methods.map((m: any) => ({ code: String(m.code), name: String(m.name), ...methodAvailability(String(m.code), { hasMoneiToken }) }));
    const netTotal = lines.reduce((n, l) => n + (l.amount_excl_tax ?? l.amount), 0);

    res.json({
      payment_methods: paymentMethods,
      net_total: Math.round(netTotal * 100) / 100,
      tax_total: amountDue != null ? Math.round((amountDue - netTotal) * 100) / 100 : null,
      product_set_id: Number(set.id),
      status: String(set.status),
      has_previous: set.previous_product_set_id != null,
      changes,
      amount_due: amountDue,
      payment_required: amountDue != null && amountDue > 0,
      immediate_lines: lines,
      currency: 'EUR',
      error,
    });
  } catch (err) { next(err); }
});

productSetsRouter.use('/:id', productSetDraftRouter);

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

/**
 * #1535 — the member cancels their own unpaid checkout. The member is the
 * session's (never named by the request) and must own the version; the same
 * guard as the Admin's decides, so a payment whose outcome is unknown or that
 * settled is never discarded (`409 payment_unresolved`).
 */
meProductSetsRouter.delete('/:id', async (req, res) => {
  const ctx = getTenantContext(req);
  let memberId: number;
  try { memberId = await resolveMemberId(ctx.gymId, ctx); } catch { return res.status(404).json({ error: 'ProductSet not found' }); }
  const set = await loadSet(ctx.gymId, req.params.id);
  if (!set || Number(set.owner_member_id) !== memberId) return res.status(404).json({ error: 'ProductSet not found' });
  const result = await cancelCheckout(ctx.gymId, set);
  if (result.kind !== 'cancelled') return res.status(409).json(cancelFailure(result));
  recordAudit(req, { action: 'cancel', entityType: 'product_set', entityId: set.id });
  res.status(204).end();
});

export { isDraftExpired };
