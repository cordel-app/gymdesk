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
  startProductPurchase,
} from './me-products';
import { loadPromotionOffersDetailed } from './member-product-promotions';
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
import { DateTime } from 'luxon';
import { endDateOnCancel } from '../domain/productValidity';
import { resolveTimeZone } from '../domain/homeDashboard';
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
      WHERE gym_id = ? AND member_id = ? AND status IN ('active', 'pending_payment')`,
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
  const { offers, skipped } = await loadPromotionOffersDetailed(gymId, memberId, items.map((item) => ({
    id: item.id, type: item.type, billing_frequency: item.billing_frequency, price_incl_tax: item.price_incl_tax,
  })));
  return items.map((item) => ({
    ...item,
    recurring: isRecurringFrequency(item.billing_frequency),
    promotions: offers.get(item.id) ?? [],
    // #1655 — hidden only by the new-members-only rule; explanatory, never applicable.
    unavailable_promotions: skipped.get(item.id) ?? [],
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
 * #1693 — POST /members/:memberId/product-purchases/:id/cancel
 *
 * Records the cancellation day of a completed (`active`) one-time purchase. It
 * never moves `valid_until`: the member keeps what they paid for through the end
 * date; a purchase with no defined validity ends the day it is cancelled.
 * Idempotent — a repeat returns the stored dates untouched. `status` is not
 * changed (`cancelled` there means the payment never completed).
 */
memberProductPurchasesRouter.post('/:id/cancel', requireModuleWrite('MEMBERS'), async (req, res, next) => {
  const tenantCtx = getTenantContext(req);
  const { gymId } = tenantCtx;
  const memberId = memberIdOf(req);
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(memberId) || memberId <= 0 || !Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid id' });
  }
  try {
    const member = await loadMember(gymId, memberId);
    if (!member) return res.status(404).json({ error: 'Member not found' });
    const result = await db.transaction(async (tx) => {
      const { rows } = await tx.query<any>(
        `SELECT mp.status, DATE_FORMAT(mp.valid_until, '%Y-%m-%d') AS valid_until,
                DATE_FORMAT(mp.cancelled_on, '%Y-%m-%d') AS cancelled_on, g.time_zone
           FROM member_products_oneoff_snapshot mp JOIN gyms g ON g.id = mp.gym_id
          WHERE mp.id = ? AND mp.gym_id = ? AND mp.member_id = ? FOR UPDATE`,
        [id, gymId, memberId],
      );
      const row = rows[0];
      if (!row) return { status: 404 as const };
      if (row.status !== 'active') return { status: 409 as const };
      if (row.cancelled_on) return { status: 200 as const, changed: false, row };
      const today = DateTime.now().setZone(resolveTimeZone(row.time_zone)).toISODate()!;
      const validUntil = endDateOnCancel(row.valid_until, today);
      const actor = resolveRequestActor(tenantCtx) ?? member.name;
      await tx.query(
        `UPDATE member_products_oneoff_snapshot
            SET cancelled_on = ?, valid_until = ?, modified_at = UTC_TIMESTAMP(), modified_by = ?
          WHERE id = ? AND gym_id = ? AND cancelled_on IS NULL`,
        [today, validUntil, actor, id, gymId],
      );
      return { status: 200 as const, changed: true, row: { cancelled_on: today, valid_until: validUntil } };
    });
    if (result.status === 404) return res.status(404).json({ error: 'Purchase not found' });
    if (result.status === 409) return res.status(409).json({ error: 'not_active', message: 'Only a completed purchase can be cancelled' });
    if (result.changed) {
      recordAudit(req, {
        action: 'cancel', entityType: 'member', entityId: memberId,
        next: { product_purchase: id, cancelled_on: result.row.cancelled_on, valid_until: result.row.valid_until },
      });
    }
    res.json({ id, cancelled_on: result.row.cancelled_on, valid_until: result.row.valid_until });
  } catch (err) {
    next(err);
  }
});
