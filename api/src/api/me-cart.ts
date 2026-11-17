/**
 * #2949 stage 4 — the member's standalone cart purchases: one-time Products in the cart that no
 * Product Set carries (§3). Mounted at `/me/cart`, the member never named by the request (#1036).
 *
 *   GET    /purchases        the member's standalone `in_cart` purchases, with their expiry (#2962)
 *   POST   /purchases        adds one (`resolveDraftPurchase()` + `writeDraftPurchase()`, the path a
 *                            staff draft and a cart Product Set's purchase already take); no Product
 *                            Set is created, read or required
 *   DELETE /purchases/:id    removes one (a hard delete: it has charged nothing)
 *   POST   /checkout         pays them together, one Billing Event (`startCartCheckout()`)
 *
 * The body names a Product, its Promotions and who it is for — never a price or a discount.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { requireFeatureEnabled } from '../infra/featureFlags';
import { getRequestLocale } from '../infra/locale';
import {
  IN_CART_PURCHASE_STATUS, PURCHASE_CART_TTL_MINUTES, isDraftAddable, purchaseBlockResponse,
} from '../domain/memberProductPurchase';
import { pricingRefusalResponse } from '../domain/productPurchasePricing';
import { resolveMemberId } from './me';
import { refuseUnlessMayAdd } from './family-add-rights';
import { resolvePayerFor } from './payer-resolution';
import { AssigneeRefused } from './product-assignee';
import {
  PricingRefused, PromotionRefused, PurchaseRefused,
  expireStandalonePurchaseDrafts, resolveDraftPurchase, writeDraftPurchase,
} from './me-products';
import { MEMBER_PURCHASE_SNAPSHOTS_SQL, memberPurchaseSnapshotParams } from './purchase-snapshots';
import { lockPurchase, deletePurchase } from './purchase-writer';
import { CartCheckoutRefused, cartTotal, loadCartPurchases, startCartCheckout } from './cart-checkout';

export const meCartRouter = Router();
meCartRouter.use(requireRole('member'), requireFeatureEnabled('member_web.my_membership'), requireFeatureEnabled('financials.products'));

/** The checkout's budget: a provider round trip and a hosted page each (the purchase route's). */
const cartCheckoutRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => (req as any).auth?.userId ?? 'unauthenticated',
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: 'Too many purchase attempts. Please try again later.' }),
});

function parseIds(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  const ids = raw.map(Number);
  return ids.every((n) => Number.isInteger(n) && n > 0) ? ids : null;
}

async function memberOf(req: Request): Promise<{ gymId: string; memberId: number }> {
  const ctx = getTenantContext(req);
  return { gymId: ctx.gymId, memberId: await resolveMemberId(ctx.gymId, ctx) };
}

/** The cart as the Members App reads it: the items, their total and when each expires. */
async function cartBody(gymId: string, memberId: number) {
  const purchases = await loadCartPurchases(db, gymId, memberId);
  return {
    purchases: purchases.map((p) => ({
      ...p,
      cart_expires_at: p.created_at == null ? null
        : new Date(new Date(p.created_at).getTime() + PURCHASE_CART_TTL_MINUTES * 60_000).toISOString(),
    })),
    total: cartTotal(purchases),
    currency: purchases[0]?.currency ?? null,
  };
}

meCartRouter.get('/purchases', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { gymId, memberId } = await memberOf(req);
    await expireStandalonePurchaseDrafts({ gymId, memberId });
    res.json(await cartBody(gymId, memberId));
  } catch (err) { next(err); }
});

meCartRouter.post('/purchases', async (req: Request, res: Response, next: NextFunction) => {
  const body = req.body ?? {};
  const productId = Number(body.product_id);
  if (!Number.isInteger(productId) || productId <= 0) return res.status(400).json({ error: 'product_id must be a positive integer' });
  if (body.direct_discount_percent != null && body.direct_discount_percent !== '' && Number(body.direct_discount_percent) !== 0) {
    return res.status(403).json({ error: 'direct_discount_not_allowed', message: 'A direct discount can only be applied by an Admin' });
  }
  const promotionIds = body.promotion_ids == null ? [] : parseIds(body.promotion_ids);
  if (promotionIds === null) return res.status(400).json({ error: 'promotion_ids must be an array of positive integers' });
  try {
    const { gymId, memberId } = await memberOf(req);
    if (await refuseUnlessMayAdd(res, gymId, memberId)) return;
    const { rows: m } = await db.query<{ name: string; email: string; billing_frequency: string | null }>(
      `SELECT m.name, m.email, p.billing_frequency FROM members m
         LEFT JOIN products p ON p.id = ? AND p.gym_id = m.gym_id
        WHERE m.gym_id = ? AND m.id = ?`, [productId, gymId, memberId]);
    if (!m[0]) return res.status(404).json({ error: 'Member profile not found' });
    // A recurring Product is a line of a Product Set (`/me/product-sets/:id/services`), never a one-time purchase.
    if (isDraftAddable({ billing_frequency: m[0].billing_frequency })) {
      return res.status(400).json({ error: 'recurring_product', message: 'A recurring Product is added to a Product Set' });
    }
    await expireStandalonePurchaseDrafts({ gymId, memberId });
    // One of each Product in the cart, wherever the cart holds it (standalone or in a cart Product Set).
    const { rows: held } = await db.query<{ id: number }>(
      `SELECT mp.id FROM ${MEMBER_PURCHASE_SNAPSHOTS_SQL} mp WHERE mp.product_id = ? AND mp.status = ? LIMIT 1`,
      [...memberPurchaseSnapshotParams(gymId, memberId), productId, IN_CART_PURCHASE_STATUS]);
    if (held[0]) return res.status(409).json({ error: 'already_in_cart', message: 'This Product is already in the cart' });

    const input = {
      gymId, memberId, memberName: m[0].name, memberEmail: m[0].email, productId,
      promotionIds, assignedMemberInput: body.assigned_member_id,
    };
    const resolved = await resolveDraftPurchase(input);
    const purchaseId = await db.transaction((tx) => writeDraftPurchase(tx, input, resolved));
    req.log?.info({ memberId, productId, purchaseId }, 'Member cart purchase added');
    res.status(201).json({ purchase_id: purchaseId, amount: resolved.snapshot.amount, currency: resolved.snapshot.currency });
  } catch (err: any) {
    if (err instanceof PurchaseRefused) {
      const { status, ...out } = purchaseBlockResponse(err.block);
      return res.status(status).json(out);
    }
    if (err instanceof PricingRefused) {
      const { status, ...out } = pricingRefusalResponse(err.refusal);
      return res.status(status).json(out);
    }
    if (err instanceof PromotionRefused) {
      return res.status(409).json({ error: 'promotion_not_applicable', message: 'This promotion is no longer available for this product' });
    }
    if (err instanceof AssigneeRefused) return res.status(400).json({ error: err.code, message: err.message });
    if (err?.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

meCartRouter.delete('/purchases/:id', async (req: Request, res: Response, next: NextFunction) => {
  const purchaseId = Number(req.params.id);
  if (!Number.isInteger(purchaseId) || purchaseId <= 0) return res.status(404).json({ error: 'not_found' });
  try {
    const { gymId, memberId } = await memberOf(req);
    const removed = await db.transaction(async (tx) => {
      if (!(await lockPurchase(tx, gymId, memberId, purchaseId))) return false;
      // Only a standalone one: a purchase a cart Product Set carries is removed through that set.
      if (!(await loadCartPurchases(tx, gymId, memberId)).some((p) => p.id === purchaseId)) return false;
      return deletePurchase(tx, gymId, purchaseId, { memberId, status: IN_CART_PURCHASE_STATUS });
    });
    if (!removed) return res.status(404).json({ error: 'not_found' });
    res.json({ id: purchaseId, deleted: true });
  } catch (err) { next(err); }
});

meCartRouter.post('/checkout', cartCheckoutRateLimit as any, async (req: Request, res: Response, next: NextFunction) => {
  const raw = (req.body ?? {}).purchase_ids;
  const purchaseIds = raw == null ? null : parseIds(raw);
  if (raw != null && purchaseIds === null) return res.status(400).json({ error: 'purchase_ids must be an array of positive integers' });
  try {
    const { gymId, memberId } = await memberOf(req);
    // #2123: a family member's purchase is paid by the Family Owner, never raised by the beneficiary.
    if ((await resolvePayerFor(db, gymId, memberId)).viaFamily) {
      return res.status(403).json({ error: 'family_owner_pays', message: 'Your family owner pays for this purchase' });
    }
    await expireStandalonePurchaseDrafts({ gymId, memberId });
    const { rows: m } = await db.query<{ email: string | null }>(
      'SELECT email FROM members WHERE gym_id = ? AND id = ?', [gymId, memberId]);
    if (!m[0]) return res.status(404).json({ error: 'Member profile not found' });
    const result = await startCartCheckout({
      gymId, memberId, memberEmail: m[0].email ?? '', actorName: null,
      purchaseIds, requestLocale: getRequestLocale(req),
    });
    req.log?.info({ memberId, billingEventId: result.billingEventId }, 'Member cart checkout started');
    res.status(201).json(result);
  } catch (err: any) {
    if (err instanceof CartCheckoutRefused) return res.status(err.status).json({ error: err.code, message: err.message });
    next(err);
  }
});
