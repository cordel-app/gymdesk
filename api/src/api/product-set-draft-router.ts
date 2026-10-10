import { Router, Response } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { computeAssignmentBillingEventSimulation } from '../domain/assignmentBillingEventSimulation';
import { emptyBillingEventSimulation } from '../domain/billingEventSimulation';
import { ProductBenefitCategory } from '../domain/productClassification';
import { applyPromotionToProductSet, validatePromotionSelection } from './membership-promotions';
import { loadProductSetSimulationAssignment } from './product-set-configuration';
import {
  DraftRefusal, LockedDraft, addCoveredMember, addService, isRefusal, loadBenefitSection, lockDraft,
  removeCoveredMember, removeService, setBillingDuration, setFeeBenefit, setNegotiatedFee, writeBenefitSection,
} from './product-set-draft';

/**
 * #1325 PR 4 — the Draft's configuration API, mounted under `/product-sets/:id`.
 *
 *   GET    /benefits/:category            a section as frozen
 *   PUT    /benefits/:category            replace-all, `{ items: [{ product_id, quantity }] }`
 *   PUT    /billing-duration              Free / Paid / Bonus / Pre-paid periods, auto renew
 *   PUT    /fee                           a negotiated Membership Fee (reason required)
 *   PUT    /fee-benefit                   the Personal Membership Fee Benefit
 *   POST   /services, DELETE /services/:serviceId
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
  }
}

const isRef = (o: any): o is DraftRefusal => o != null && typeof o.kind === 'string' && !('ok' in o);

/** Runs `fn` on the locked Draft in one transaction and answers uniformly. */
async function edit(req: any, res: Response, action: string,
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

productSetDraftRouter.post('/members', requireModuleWrite('PAYMENTS'), (req, res, next) =>
  edit(req, res, 'update', (tx, d) => addCoveredMember(tx, d, Number(req.body?.member_id)), next,
    { add_member: req.body?.member_id }));

productSetDraftRouter.delete('/members/:memberId', requireModuleWrite('PAYMENTS'), (req, res, next) =>
  edit(req, res, 'update', (tx, d) => removeCoveredMember(tx, d, Number(req.params.memberId)), next,
    { remove_member: Number(req.params.memberId) }));

productSetDraftRouter.post('/promotions', requireModuleWrite('PAYMENTS'), (req, res, next) => {
  const { gymId, userId } = getTenantContext(req);
  const promotionId = Number(req.body?.promotion_id);
  if (!Number.isInteger(promotionId) || promotionId <= 0) return res.status(400).json({ error: 'promotion_id must be a positive integer' });
  return edit(req, res, 'update', async (tx, draft) => {
    if (draft.membership_plan_id == null) return { kind: 'invalid' as const, message: 'A ProductSet without a Membership Plan takes no Promotion' };
    const selectionError = await validatePromotionSelection(gymId, draft.membership_plan_id, [promotionId], draft.owner_member_id);
    if (selectionError) return { kind: 'invalid' as const, message: selectionError.error };
    try {
      const applied = await applyPromotionToProductSet(tx, gymId, userId ?? 'unknown', draft.id, promotionId);
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
    const { rowCount } = await tx.query(
      'DELETE FROM user_membership_promotions WHERE id = ? AND gym_id = ? AND product_set_id = ?',
      [Number(req.params.applicationId), draft.gym_id, draft.id]);
    if (rowCount === 0) return { kind: 'not_found' as const };
    await tx.query('UPDATE product_sets SET last_activity_at = UTC_TIMESTAMP() WHERE id = ?', [draft.id]);
    return { ok: true as const };
  }, next, { remove_promotion: Number(req.params.applicationId) }));

productSetDraftRouter.get('/billing-event-simulation', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    const assignment = await loadProductSetSimulationAssignment(gymId, Number((req.params as any).id));
    if (!assignment) return res.status(404).json({ error: 'not_found' });
    res.json(computeAssignmentBillingEventSimulation({ assignment }));
  } catch (err) { next(err); }
});

export { emptyBillingEventSimulation };
