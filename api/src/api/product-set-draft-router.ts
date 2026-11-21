import { Router, Response } from 'express';
import { nameSimulatedEvents } from './billing-event-name';
import { syncPlanSnapshot } from './plan-snapshot-sync';
import { ownPrimaryPlanSnapshot } from './plan-snapshot-ownership';
import { db } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { computeAssignmentBillingEventSimulation, sharedCycleHorizon } from '../domain/assignmentBillingEventSimulation';
import { emptyBillingEventSimulation, BillingEventLine } from '../domain/billingEventSimulation';
import { composeDraftSimulation, toBillingEventLine } from '../domain/draftBillingSimulation';
import { commitCharge } from './product-set-checkout';
import { ProductBenefitCategory } from '../domain/productClassification';
import { resolveRequestActor } from '../domain/auditActor';
import { effectivePrice, planAssignabilityError } from './user-memberships';
import { resolveDeclinedBenefits } from './declined-plan-benefits';
import { applyPromotionToProductSet, validatePromotionSelection } from './membership-promotions';
import { loadProductSetSimulationAssignments } from './plan-snapshot-assignments';
import { mergeBillingEventForecasts } from './me-billing-forecast';
import { loadSetPurchases } from './set-purchases';
import { cartPurchasesForCharge } from './cart-checkout';
import { IN_CART_PURCHASE_STATUS, PENDING_PURCHASE_STATUS } from '../domain/memberProductPurchase';
import {
  DraftRefusal, LockedDraft, addCoveredMember, addService, isRefusal, loadBenefitSection, lockDraft,
  addStaffPlanToDraft, removeStaffPlanFromDraft,
  removeCoveredMember, removeService, setBillingDuration, setServiceQuantity, setFeeBenefit, setNegotiatedFee, writeBenefitSection,
} from './product-set-draft';

/**
 * #1325 PR 4 — the Draft's configuration API, mounted under `/product-sets/:id`.
 *
 *   GET    /benefits/:category            a section as frozen
 *   PUT    /benefits/:category            replace-all, `{ items: [{ product_id, quantity }] }`
 *   PUT    /billing-duration              Free / Paid / Bonus / Pre-paid periods, auto renew
 *   PUT    /fee                           a negotiated Membership Fee (reason required)
 *   PUT    /fee-benefit                   the Personal Membership Fee Benefit
 *   POST   /services, PUT /services/:serviceId (quantity), DELETE /services/:serviceId
 *   POST   /promotions, DELETE /promotions/:applicationId
 *   POST   /members, DELETE /members/:memberId
 *   GET    /billing-event-simulation      the Billing Event Forecast of the Draft
 *
 * Every write locks the Draft, refuses a committed or expired one, refreshes its
 * two-hour expiry and is audited against the `product_set`. A committed version
 * is never edited: a change is a new version.
 */

export const productSetDraftRouter = Router({ mergeParams: true });

const CATEGORIES: ProductBenefitCategory[] = ['session', 'oneoff', 'periodical'];

function refuse(res: Response, r: DraftRefusal) {
  switch (r.kind) {
    case 'not_found': return res.status(404).json({ error: 'not_found' });
    case 'not_a_draft': return res.status(409).json({ error: 'not_a_draft', status: r.status, message: 'Only a Draft can be edited; a committed version is changed through a new version.' });
    case 'expired': return res.status(410).json({ error: 'draft_expired' });
    case 'invalid': return res.status(400).json({ error: r.message });
    case 'conflict': return res.status(409).json({ error: r.error, message: r.message });
  }
}

const isRef = (o: any): o is DraftRefusal => o != null && typeof o.kind === 'string' && !('ok' in o);

/** Runs `fn` on the locked Draft in one transaction and answers uniformly. */
export async function edit(req: any, res: Response, action: string,
  fn: (tx: any, draft: LockedDraft) => Promise<{ ok: true; [k: string]: unknown } | DraftRefusal>,
  next: (err: unknown) => void, detail?: Record<string, unknown>) {
  const { gymId } = getTenantContext(req);
  const id = Number((req.params as any).id);
  if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'not_found' });
  try {
    const out = await db.transaction(async (tx) => {
      const draft = await lockDraft(tx, gymId, id);
      if (isRefusal(draft)) return draft;
      const result = await fn(tx, draft);
      if (isRef(result)) throw Object.assign(new Error('refused'), { refusal: result });
      await syncPlanSnapshot(tx, gymId, id);
      return result;
    }).catch((err) => {
      if (err?.refusal) return err.refusal as DraftRefusal;
      throw err;
    });
    if (isRef(out)) return refuse(res, out);
    recordAudit(req, { action, entityType: 'product_set', entityId: id, next: detail ?? out });
    return res.json({ product_set_id: id, ...out });
  } catch (err: any) {
    if (err?.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

productSetDraftRouter.get('/benefits/:category', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const category = req.params.category as ProductBenefitCategory;
  if (!CATEGORIES.includes(category)) return res.status(404).json({ error: 'unknown section' });
  try {
    const { rows } = await db.query('SELECT id FROM product_sets WHERE id = ? AND gym_id = ?', [Number((req.params as any).id), gymId]);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json(await loadBenefitSection(gymId, Number((req.params as any).id), category));
  } catch (err) { next(err); }
});

productSetDraftRouter.put('/benefits/:category', requireModuleWrite('PAYMENTS'), (req, res, next) => {
  const category = req.params.category as ProductBenefitCategory;
  if (!CATEGORIES.includes(category)) return res.status(404).json({ error: 'unknown section' });
  return edit(req, res, 'update', async (tx, draft) => {
    const r = await writeBenefitSection(tx, draft, category, req.body?.items);
    return isRef(r) ? r : { ok: true as const, section: category };
  }, next, { [`${category}_benefits`]: req.body?.items });
});

productSetDraftRouter.put('/billing-duration', requireModuleWrite('PAYMENTS'), (req, res, next) =>
  edit(req, res, 'update', (tx, d) => setBillingDuration(tx, d, req.body), next, { billing_duration: req.body }));

productSetDraftRouter.put('/fee', requireModuleWrite('PAYMENTS'), (req, res, next) =>
  edit(req, res, 'update', (tx, d) => setNegotiatedFee(tx, d, req.body), next, { negotiated_fee: req.body }));

productSetDraftRouter.put('/fee-benefit', requireModuleWrite('PAYMENTS'), (req, res, next) =>
  edit(req, res, 'update', (tx, d) => setFeeBenefit(tx, d, req.body), next, { personal_fee_benefit: req.body }));

productSetDraftRouter.post('/services', requireModuleWrite('PAYMENTS'), (req, res, next) =>
  edit(req, res, 'update', (tx, d) => addService(tx, d, req.body), next, { add_service: req.body }));

productSetDraftRouter.delete('/services/:serviceId', requireModuleWrite('PAYMENTS'), (req, res, next) =>
  edit(req, res, 'update', (tx, d) => removeService(tx, d, Number(req.params.serviceId)), next,
    { remove_service: Number(req.params.serviceId) }));

productSetDraftRouter.put('/services/:serviceId', requireModuleWrite('PAYMENTS'), (req, res, next) =>
  edit(req, res, 'update', (tx, d) => setServiceQuantity(tx, d, Number(req.params.serviceId), req.body?.quantity), next,
    { service_quantity: { service: Number(req.params.serviceId), quantity: req.body?.quantity } }));

productSetDraftRouter.post('/members', requireModuleWrite('PAYMENTS'), (req, res, next) =>
  edit(req, res, 'update', (tx, d) => addCoveredMember(tx, d, Number(req.body?.member_id)), next,
    { add_member: req.body?.member_id }));

productSetDraftRouter.delete('/members/:memberId', requireModuleWrite('PAYMENTS'), (req, res, next) =>
  edit(req, res, 'update', (tx, d) => removeCoveredMember(tx, d, Number(req.params.memberId)), next,
    { remove_member: Number(req.params.memberId) }));

/**
 * #2966 stage 2 — staff adds a Membership Plan to the member's in-cart ProductSet. The plan is a
 * plan snapshot of the set (addressed by its snapshot id), never a competing version and never a
 * `user_memberships` row; everything already on the Draft is preserved. Body: `membership_plan_id`,
 * optional `starts_at` (default the Draft's), `membership_fee_price`, `declined_benefits`,
 * `owner_is_beneficiary`.
 */
productSetDraftRouter.post('/plans', requireModuleWrite('PAYMENTS'), async (req, res, next) => {
  try {
    const { gymId } = getTenantContext(req);
    const planId = Number(req.body?.membership_plan_id);
    if (!Number.isInteger(planId) || planId <= 0) return res.status(400).json({ error: 'membership_plan_id must be a positive integer' });
    if (req.body?.owner_is_beneficiary !== undefined && typeof req.body.owner_is_beneficiary !== 'boolean') {
      return res.status(400).json({ error: 'owner_is_beneficiary must be a boolean' });
    }
    const planError = await planAssignabilityError(gymId, planId);
    if (planError) return res.status(planError.status).json({ error: planError.error });
    const { rows } = await db.query<any>('SELECT starts_at FROM product_sets WHERE id = ? AND gym_id = ?', [Number(req.params.id), gymId]);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    const draftStart = rows[0].starts_at instanceof Date ? rows[0].starts_at.toISOString().slice(0, 10) : String(rows[0].starts_at).slice(0, 10);
    const startsAt = req.body?.starts_at ? String(req.body.starts_at).slice(0, 10) : draftStart;
    const eff = await effectivePrice(planId, gymId, startsAt);
    if (!eff) return res.status(404).json({ error: 'Plan not found' });
    const declined = await resolveDeclinedBenefits(gymId, planId, req.body?.declined_benefits);
    if (declined.error !== undefined) return res.status(400).json({ error: declined.error });
    const feeGiven = req.body?.membership_fee_price != null && req.body.membership_fee_price !== '';
    const fee = feeGiven ? Number(req.body.membership_fee_price) : (eff.plan_price_id != null ? eff.price : null);
    if (feeGiven && (!Number.isFinite(fee) || (fee as number) < 0)) return res.status(400).json({ error: 'membership_fee_price must be a non-negative number' });
    const actor = resolveRequestActor(getTenantContext(req));
    return edit(req, res, 'update', (tx, d) => addStaffPlanToDraft(tx, d, {
      membershipPlanId: planId, membershipFeePrice: fee, startsAt,
      ownerIsBeneficiary: req.body?.owner_is_beneficiary !== false, declinedBenefits: declined.declined, actor,
    }), next, { add_plan: planId });
  } catch (err) { next(err); }
});

productSetDraftRouter.delete('/plans/:planSnapshotId', requireModuleWrite('PAYMENTS'), (req, res, next) => {
  const snapshotId = Number(req.params.planSnapshotId);
  if (!Number.isInteger(snapshotId) || snapshotId <= 0) return res.status(404).json({ error: 'not_found' });
  return edit(req, res, 'update', (tx, d) => removeStaffPlanFromDraft(tx, d, snapshotId), next, { remove_plan: snapshotId });
});

productSetDraftRouter.post('/promotions', requireModuleWrite('PAYMENTS'), (req, res, next) => {
  const { gymId, userId } = getTenantContext(req);
  const promotionId = Number(req.body?.promotion_id);
  if (!Number.isInteger(promotionId) || promotionId <= 0) return res.status(400).json({ error: 'promotion_id must be a positive integer' });
  return edit(req, res, 'update', async (tx, draft) => {
    if (draft.membership_plan_id == null) return { kind: 'invalid' as const, message: 'A ProductSet without a Membership Plan takes no Promotion' };
    const selectionError = await validatePromotionSelection(gymId, draft.membership_plan_id, [promotionId], draft.owner_member_id);
    if (selectionError) return { kind: 'invalid' as const, message: selectionError.error };
    try {
      const applied = await applyPromotionToProductSet(tx, gymId, resolveRequestActor(getTenantContext(req)), draft.id, promotionId);
      await tx.query('UPDATE product_sets SET last_activity_at = UTC_TIMESTAMP() WHERE id = ?', [draft.id]);
      return { ok: true as const, application_id: applied.application_id };
    } catch (err: any) {
      if (err?.status) return { kind: 'invalid' as const, message: err.message };
      throw err;
    }
  }, next, { apply_promotion: promotionId });
});

productSetDraftRouter.delete('/promotions/:applicationId', requireModuleWrite('PAYMENTS'), (req, res, next) =>
  edit(req, res, 'update', async (tx, draft) => {
    // A Draft has charged nothing, so removing an application deletes it (and
    // its grant snapshots, by the FK) — there is no history to preserve yet.
    // M4b-2: the plan's applied Promotions change, so the Draft takes its own copy of the plan.
    await ownPrimaryPlanSnapshot(tx, draft.gym_id, draft.id);
    const { rowCount } = await tx.query(
      'DELETE FROM user_membership_promotions WHERE id = ? AND gym_id = ? AND product_set_id = ?',
      [Number(req.params.applicationId), draft.gym_id, draft.id]);
    if (rowCount === 0) return { kind: 'not_found' as const };
    // #3026 stage 3c-3: the plan snapshot's row goes with it (nothing derives it away any more).
    const { deletePlanPromotionReferences } = await import('./plan-promotion-writer');
    await deletePlanPromotionReferences(tx, draft.gym_id, [Number(req.params.applicationId)]);
    await tx.query('UPDATE product_sets SET last_activity_at = UTC_TIMESTAMP() WHERE id = ?', [draft.id]);
    return { ok: true as const };
  }, next, { remove_promotion: Number(req.params.applicationId) }));

export async function simulationHandler(req: any, res: any, next: any) {
  const { gymId } = getTenantContext(req);
  try {
    const id = Number((req.params as any).id);
    // #2899: every Membership Plan of the version, each through the engine on its own and merged
    // by date — the loader `planScheduledEvents()` persists from, so a Draft that adds a plan beside
    // a running one forecasts both rather than whichever plan the one-plan loader happened to read.
    const assignments = await loadProductSetSimulationAssignments(gymId, id);
    if (assignments.length === 0) return res.status(404).json({ error: 'not_found' });
    // #3030: one shared horizon — two complete cycles of the plan with the longest cycle.
    const sharedHorizonUntil = sharedCycleHorizon(assignments);
    const base = mergeBillingEventForecasts(assignments.map((assignment) =>
      computeAssignmentBillingEventSimulation({ assignment, dynamicHorizon: true, sharedHorizonUntil })));

    // #1867 stage 2 — the Draft's complete schedule: the initial payment (what
    // committing asks for today, the figure Save & Pay charges) and the member's
    // one-offs still to be paid. Only an uncommitted version has either.
    const { rows } = await db.query<any>(
      `SELECT id, status, owner_member_id, previous_product_set_id, starts_at
         FROM product_sets WHERE id = ? AND gym_id = ?`, [id, gymId]);
    const set = rows[0];
    if (!set || (set.status !== 'in_cart' && set.status !== 'pending_payment')) return res.json(await nameSimulatedEvents(db, gymId, base));

    let initial: { date: string; lines: BillingEventLine[] } | null = null;
    try {
      const { startsAt, charge } = await commitCharge(gymId, set);
      if (charge && charge.simulationLines.length > 0) {
        initial = { date: startsAt, lines: charge.simulationLines.map(toBillingEventLine) };
      }
    } catch { initial = null; }

    // #3031: only what the current cart carries — this Draft's own purchases and the owner's standalone
    // In Cart ones (`cartPurchasesForCharge()`, the Summary's and Save & Pay's rule), never every
    // draft / pending purchase of the member. When the initial payment was computed it already holds
    // each of them exactly once (`commitCharge()`), so they are listed separately only as a fallback.
    const oneOffs: Array<{ product_id: number | null; name: string; amount: number; list_price: number | null }> = [];
    if (!initial) {
      const cart = [
        ...(await loadSetPurchases(db, gymId, id)).filter((p) => p.status === IN_CART_PURCHASE_STATUS || p.status === PENDING_PURCHASE_STATUS),
        ...(await cartPurchasesForCharge(db, gymId, id)),
      ];
      const seen = new Set<number>();
      for (const p of cart) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        oneOffs.push({ product_id: p.product_id, name: p.product_name, amount: Number(p.amount), list_price: p.list_price });
      }
    }

    res.json(await nameSimulatedEvents(db, gymId, composeDraftSimulation({ base, initial, oneOffs, today: new Date().toISOString().slice(0, 10) })));
  } catch (err) { next(err); }
}
productSetDraftRouter.get('/billing-event-simulation', simulationHandler);

export { emptyBillingEventSimulation };
