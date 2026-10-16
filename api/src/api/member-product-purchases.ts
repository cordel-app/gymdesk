// #1521 stage 2 — a staff member buying a Product *for* a member, from the
// Members → Products tab.
//
//   GET  /members/:memberId/product-purchases/catalogue
//   POST /members/:memberId/product-purchases/quote
//   POST /members/:memberId/product-purchases
//
// It adds no rule of its own: the catalogue is the gym's active Products
// (`staffProductCatalogueSql()`), the Promotions are the member path's loader,
// the price is `priceProductPurchase()`, a one-time Product goes through
// `startProductPurchase()` and a recurring one becomes a Draft ProductSet
// (`startRecurringPurchaseDraft()`) that only Save & Pay activates.
//
// Two rules are this router's: the **direct discount is the Admin's alone**
// (a gym `admin` or the platform superadmin acting as one — never another
// role, whatever its Members write access), and every answer is re-resolved
// server-side from the Product's id, so the UI is never the enforcement.

import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { resolveRequestActor } from '../domain/auditActor';
import {
  PRODUCT_COLUMNS,
  PricingRefused,
  PromotionRefused,
  PurchaseRefused,
  grossPrice,
  deletePurchaseDraft,
  saveProductPurchaseDraft,
  startProductPurchase,
} from './me-products';
import { loadAppliedPromotionLists, loadPromotionOffers } from './member-product-promotions';
import { shapeMemberProduct, staffProductCatalogueSql } from '../domain/memberProductCatalogue';
import { isRecurringFrequency } from '../domain/productClassification';
import {
  oneTimeProductAlreadyOwned,
  parseDirectDiscountPercent,
  priceProductPurchase,
  pricingRefusalResponse,
  vatPortion,
} from '../domain/productPurchasePricing';
import { purchaseBlockResponse } from '../domain/memberProductPurchase';
import { startRecurringPurchaseDraft } from './recurring-purchase-draft';
import { loadEditLock } from './product-set-checkout';

export const memberProductPurchasesRouter = Router({ mergeParams: true });

const todayUtc = () => new Date().toISOString().slice(0, 10);

function memberIdOf(req: any): number {
  return parseInt(String(req.params.memberId), 10);
}

async function loadMember(gymId: string, memberId: number) {
  if (!Number.isInteger(memberId) || memberId <= 0) return null;
  const { rows } = await db.query<{ id: number; name: string; email: string | null }>(
    'SELECT id, name, email FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [memberId, gymId],
  );
  return rows[0] ?? null;
}

/** The Products this member already holds or is paying for, by id. */
async function ownedOneTimeProductIds(gymId: string, memberId: number): Promise<Set<number>> {
  const { rows } = await db.query<{ product_id: number; status: string }>(
    `SELECT product_id, status FROM member_products_oneoff_snapshot
      WHERE gym_id = ? AND member_id = ? AND status IN ('active', 'pending_payment', 'draft')`,
    [gymId, memberId],
  );
  const byProduct = new Map<number, string[]>();
  for (const r of rows) byProduct.set(Number(r.product_id), [...(byProduct.get(Number(r.product_id)) ?? []), r.status]);
  const owned = new Set<number>();
  for (const [productId, statuses] of byProduct) {
    if (oneTimeProductAlreadyOwned(statuses)) owned.add(productId);
  }
  return owned;
}

function directDiscountFrom(req: any, res: any): { percent: number | null } | null {
  const raw = (req.body ?? {}).direct_discount_percent;
  const parsed = parseDirectDiscountPercent(raw);
  if ('error' in parsed) {
    const { status, ...body } = pricingRefusalResponse(parsed.error);
    res.status(status).json(body);
    return null;
  }
  if (parsed.percent != null && getTenantContext(req).role !== 'admin') {
    res.status(403).json({
      error: 'direct_discount_not_allowed',
      message: 'A direct discount can only be applied by an Admin',
    });
    return null;
  }
  return parsed;
}

function promotionIdsFrom(req: any, res: any): number[] | null {
  const raw = (req.body ?? {}).promotion_ids;
  if (raw == null) return [];
  if (!Array.isArray(raw) || !raw.every((v) => Number.isInteger(Number(v)) && Number(v) > 0)) {
    res.status(400).json({ error: 'Invalid promotion_ids' });
    return null;
  }
  return raw.map(Number);
}

/** One Product the staff selector may offer, with what is on offer for it. */
async function staffCatalogue(gymId: string, memberId: number) {
  const { rows } = await db.query<any>(
    `SELECT ${PRODUCT_COLUMNS}
       FROM products p
       LEFT JOIN tax_rates tr ON tr.id = p.tax_rate_id
      WHERE p.gym_id = ? AND ${staffProductCatalogueSql('p')}
      ORDER BY p.name ASC`,
    [gymId],
  );
  const owned = await ownedOneTimeProductIds(gymId, memberId);
  const items = rows
    .map((row: any) => ({
      ...shapeMemberProduct(row, grossPrice(row)),
      tax_rate_percent: row.tax_rate_percent == null ? null : Number(row.tax_rate_percent),
    }))
    // A Product with no price has nothing to charge or to simulate.
    .filter((item) => item.price_incl_tax != null && item.price_incl_tax > 0)
    // #1521 (decision 3): a one-time Product already held is not offered again;
    // a recurring one always is.
    .filter((item) => isRecurringFrequency(item.billing_frequency) || !owned.has(item.id));
  const offers = await loadPromotionOffers(gymId, memberId, items.map((item) => ({
    id: item.id, type: item.type, billing_frequency: item.billing_frequency, price_incl_tax: item.price_incl_tax,
  })));
  return items.map((item) => ({
    ...item,
    recurring: isRecurringFrequency(item.billing_frequency),
    promotions: offers.get(item.id) ?? [],
  }));
}

memberProductPurchasesRouter.get('/catalogue', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const memberId = memberIdOf(req);
  try {
    if (!(await loadMember(gymId, memberId))) return res.status(404).json({ error: 'Member not found' });
    res.json({ items: await staffCatalogue(gymId, memberId) });
  } catch (err) { next(err); }
});

/**
 * The price the purchase would be charged, and nothing else: it persists
 * nothing and creates no Draft, which is also what the Admin's form shows
 * *before* Save.
 */
memberProductPurchasesRouter.post('/quote', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const memberId = memberIdOf(req);
  try {
    if (!(await loadMember(gymId, memberId))) return res.status(404).json({ error: 'Member not found' });
    const productId = Number((req.body ?? {}).product_id);
    if (!Number.isInteger(productId) || productId <= 0) return res.status(400).json({ error: 'product_id is required' });
    const discount = directDiscountFrom(req, res);
    if (!discount) return;
    const promotionIds = promotionIdsFrom(req, res);
    if (!promotionIds) return;

    const item = (await staffCatalogue(gymId, memberId)).find((i) => i.id === productId);
    if (!item) return res.status(404).json({ error: 'Product not found' });
    const chosen = promotionIds.map((id) => item.promotions.find((o) => o.promotion_id === id) ?? null);
    if (chosen.some((o) => o === null)) {
      return res.status(409).json({ error: 'promotion_not_applicable', message: 'This promotion is not available for this product' });
    }
    const priced = priceProductPurchase({
      listPrice: item.price_incl_tax,
      promotions: chosen.map((o) => ({
        promotion_id: o!.promotion_id, promotion_name: o!.promotion_name, action: o!.action,
        value: o!.value, duration_cycles: o!.duration_cycles, stackable: o!.stackable,
      })),
      directDiscountPercent: discount.percent,
    });
    if (!priced.ok) {
      const { status, ...body } = pricingRefusalResponse(priced.refusal);
      return res.status(status).json(body);
    }
    res.json({
      product_id: item.id,
      product_name: item.name,
      recurring: item.recurring,
      billing_frequency: item.billing_frequency,
      currency: item.currency,
      tax_included: item.tax_included,
      tax_rate_percent: item.tax_rate_percent,
      tax_amount: vatPortion(priced.price.final_price, item.tax_rate_percent),
      ...priced.price,
    });
  } catch (err) { next(err); }
});

memberProductPurchasesRouter.post('/', requireModuleWrite('MEMBERS'), async (req, res, next) => {
  const tenantCtx = getTenantContext(req);
  const { gymId } = tenantCtx;
  const memberId = memberIdOf(req);
  try {
    const member = await loadMember(gymId, memberId);
    if (!member) return res.status(404).json({ error: 'Member not found' });
    const productId = Number((req.body ?? {}).product_id);
    if (!Number.isInteger(productId) || productId <= 0) return res.status(400).json({ error: 'product_id is required' });
    const discount = directDiscountFrom(req, res);
    if (!discount) return;
    const promotionIds = promotionIdsFrom(req, res);
    if (!promotionIds) return;

    const actorName = resolveRequestActor(tenantCtx) ?? member.name;
    const { rows: productRows } = await db.query<any>(
      `SELECT p.id, p.billing_frequency FROM products p
        WHERE p.gym_id = ? AND p.id = ? AND ${staffProductCatalogueSql('p')}`,
      [gymId, productId],
    );
    if (!productRows[0]) return res.status(404).json({ error: 'Product not found' });

    if (!isRecurringFrequency(productRows[0].billing_frequency)) {
      // #1657 stage 2 — Save: the purchase persists as a `draft`, unpaid.
      if ((req.body ?? {}).draft === true) {
        const saved = await saveProductPurchaseDraft({
          gymId,
          memberId,
          memberName: member.name,
          memberEmail: member.email ?? '',
          productId,
          promotionIds,
          directDiscountPercent: discount.percent,
          staff: { actorName },
        });
        recordAudit(req, {
          action: 'create', entityType: 'member', entityId: memberId,
          next: { product_purchase_draft: saved.purchaseId, product_id: productId, direct_discount_percent: discount.percent },
        });
        return res.status(201).json({ kind: 'one_time_draft', purchaseId: saved.purchaseId, amount: saved.amount, currency: saved.currency });
      }
      const result = await startProductPurchase({
        gymId,
        memberId,
        memberName: member.name,
        memberEmail: member.email ?? '',
        productId,
        promotionIds,
        directDiscountPercent: discount.percent,
        staff: { actorName },
      });
      recordAudit(req, {
        action: 'create', entityType: 'member', entityId: memberId,
        next: { product_purchase: result.purchaseId, product_id: productId, direct_discount_percent: discount.percent },
      });
      return res.status(201).json({ kind: 'one_time', ...result });
    }

    // Recurring: a Draft ProductSet through the existing workflow.
    const catalogue = await staffCatalogue(gymId, memberId);
    const item = catalogue.find((i) => i.id === productId);
    if (!item) return res.status(404).json({ error: 'Product not found' });
    const chosen = promotionIds.map((id) => item.promotions.find((o) => o.promotion_id === id) ?? null);
    if (chosen.some((o) => o === null)) {
      return res.status(409).json({ error: 'promotion_not_applicable', message: 'This promotion is not available for this product' });
    }
    // The same pure rule prices (and so refuses) the stack before anything is written.
    const priced = priceProductPurchase({
      listPrice: item.price_incl_tax,
      promotions: chosen.map((o) => ({
        promotion_id: o!.promotion_id, promotion_name: o!.promotion_name, action: o!.action,
        value: o!.value, duration_cycles: o!.duration_cycles, stackable: o!.stackable,
      })),
      directDiscountPercent: discount.percent,
    });
    if (!priced.ok) {
      const { status, ...body } = pricingRefusalResponse(priced.refusal);
      return res.status(status).json(body);
    }

    const today = todayUtc();
    const blocking = await loadEditLock(gymId, memberId, today);
    if (blocking.length > 0) return res.status(409).json({ error: 'edit_locked', blocking });

    const out = await db.transaction((tx) => startRecurringPurchaseDraft(tx, {
      gymId, memberId, productId, promotionIds, directDiscountPercent: discount.percent,
      actor: { name: actorName }, today,
    }));
    if (out.kind === 'in_flight') {
      return res.status(409).json({ error: 'in_flight', product_set_id: out.productSetId, status: out.status });
    }
    if (out.kind === 'conflict') return res.status(409).json({ error: out.error, message: out.message });
    if (out.kind === 'invalid') return res.status(400).json({ error: out.message });
    if (out.kind !== 'ok') return res.status(409).json({ error: out.kind });

    recordAudit(req, {
      action: 'create', entityType: 'product_set', entityId: out.productSetId,
      next: { recurring_purchase_product_id: productId, direct_discount_percent: discount.percent },
    });
    res.status(201).json({ kind: 'recurring_draft', product_set_id: out.productSetId, price: priced.price });
  } catch (err: any) {
    if (err instanceof PurchaseRefused) {
      const { status, ...body } = purchaseBlockResponse(err.block);
      return res.status(status).json(body);
    }
    if (err instanceof PricingRefused) {
      const { status, ...body } = pricingRefusalResponse(err.refusal);
      return res.status(status).json(body);
    }
    if (err instanceof PromotionRefused) {
      return res.status(409).json({ error: 'promotion_not_applicable', message: 'This promotion is not available for this product' });
    }
    if (err?.status === 404) return res.status(404).json({ error: err.message });
    next(err);
  }
});

/**
 * #1657 stage 2 — pay a saved draft: it is re-resolved and re-priced through the
 * same loader as a fresh purchase (a Promotion that lapsed refuses it, leaving
 * the draft untouched) and promoted to the pending purchase in one transaction.
 */
memberProductPurchasesRouter.post('/:purchaseId/pay', requireModuleWrite('MEMBERS'), async (req, res, next) => {
  const tenantCtx = getTenantContext(req);
  const { gymId } = tenantCtx;
  const memberId = memberIdOf(req);
  const purchaseId = parseInt(String(req.params.purchaseId), 10);
  try {
    const member = await loadMember(gymId, memberId);
    if (!member) return res.status(404).json({ error: 'Member not found' });
    if (!Number.isInteger(purchaseId) || purchaseId <= 0) return res.status(404).json({ error: 'Draft not found' });
    const { rows } = await db.query<any>(
      `SELECT id, product_id, direct_discount_percent FROM member_products_oneoff_snapshot
        WHERE id = ? AND gym_id = ? AND member_id = ? AND status = 'draft'`,
      [purchaseId, gymId, memberId],
    );
    const draft = rows[0];
    if (!draft) return res.status(404).json({ error: 'Draft not found' });
    const applied = (await loadAppliedPromotionLists(gymId, [purchaseId])).get(purchaseId) ?? [];
    const result = await startProductPurchase({
      gymId,
      memberId,
      memberName: member.name,
      memberEmail: member.email ?? '',
      productId: Number(draft.product_id),
      promotionIds: applied.map((p) => p.promotion_id),
      directDiscountPercent: draft.direct_discount_percent == null ? null : Number(draft.direct_discount_percent),
      staff: { actorName: resolveRequestActor(tenantCtx) ?? member.name },
      fromDraftId: purchaseId,
    });
    recordAudit(req, {
      action: 'update', entityType: 'member', entityId: memberId,
      next: { product_purchase: result.purchaseId, from_draft: purchaseId, product_id: Number(draft.product_id) },
    });
    res.status(201).json({ kind: 'one_time', ...result });
  } catch (err: any) {
    if (err instanceof PurchaseRefused) {
      const { status, ...body } = purchaseBlockResponse(err.block);
      return res.status(status).json(body);
    }
    if (err instanceof PricingRefused) {
      const { status, ...body } = pricingRefusalResponse(err.refusal);
      return res.status(status).json(body);
    }
    if (err instanceof PromotionRefused) {
      return res.status(409).json({ error: 'promotion_not_applicable', message: 'This promotion is not available for this product' });
    }
    if (err?.status === 404) return res.status(404).json({ error: err.message });
    next(err);
  }
});

/** #1657 stage 2 — Cancel: a hard delete of this member's own draft, nothing else. */
memberProductPurchasesRouter.delete('/:purchaseId', requireModuleWrite('MEMBERS'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const memberId = memberIdOf(req);
  const purchaseId = parseInt(String(req.params.purchaseId), 10);
  try {
    if (!(await loadMember(gymId, memberId))) return res.status(404).json({ error: 'Member not found' });
    if (!Number.isInteger(purchaseId) || purchaseId <= 0) return res.status(404).json({ error: 'Draft not found' });
    const removed = await deletePurchaseDraft(gymId, memberId, purchaseId);
    if (!removed) return res.status(404).json({ error: 'Draft not found' });
    recordAudit(req, {
      action: 'delete', entityType: 'member', entityId: memberId,
      previous: { product_purchase_draft: purchaseId },
    });
    res.json({ id: purchaseId, deleted: true });
  } catch (err) { next(err); }
});
