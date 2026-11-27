/**
 * #3443 — the Members App's **Purchases** tab: the signed-in member's purchases (#3251's carts),
 * newest first, a page at a time. Read-only, and the member is never named by the request (#1036).
 *
 * It decides nothing of its own: which purchases are the member's, their items, their total and their
 * Billing Events are the Member card's Purchases tab read (`loadMemberPurchases()`, #3273), so the two
 * apps cannot list a purchase differently. What this module adds is the member-facing shape
 * (`toMemberPurchaseView()`): the staff-only facts (who created or modified it, the channel, the
 * internal line and attempt ids) are left out.
 *
 * A purchase carries money (its total, its payments), so the tab is the Family Owner's, exactly as
 * Payments is (#2776, `refuseUnlessMayViewPayments()`).
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { requireFeatureEnabled } from '../infra/featureFlags';
import { resolveMemberId } from './me';
import { refuseUnlessMayViewPayments } from './family-add-rights';
import { loadMemberPurchases, type MemberPurchase } from './member-purchases';
import { db } from '../infra/db';
import { commitCharge } from './product-set-checkout';
import { cartTotal, loadCartPurchases } from './cart-checkout';

export const PURCHASE_HISTORY_DEFAULT_LIMIT = 10;
export const PURCHASE_HISTORY_MAX_LIMIT = 50;

export interface MemberPurchaseView {
  id: number;
  /** #3288: the purchase's canonical name, shown verbatim. */
  name: string | null;
  /** The purchase's own lifecycle (`in_cart` | `pending_payment` | `completed` | `cancelled`). */
  status: string;
  created_at: string;
  /** Persisted: `purchaseTotalAmount()` over its Billing Events; null with none. */
  total_amount: string | null;
  /**
   * #3495: an `in_cart` purchase's Initial Payment — what checking the cart out asks for now, the
   * figure the cart's own Summary and Save & Pay charge (`commitCharge()` for a cart carrying a
   * Product Set, `cartTotal()` for standalone purchases alone). Null on every other status, and when
   * the figure cannot be computed.
   */
  initial_payment_amount: string | null;
  owner: { id: number; name: string | null };
  plans: Array<{
    name: string | null;
    status: string;
    starts_at: string | null;
    beneficiaries: Array<{ id: number; name: string | null }>;
    products: Array<{ name: string | null; quantity: number; beneficiary: { id: number; name: string | null } | null }>;
  }>;
  products: Array<{
    kind: string;
    name: string | null;
    billing_frequency: string | null;
    quantity: number;
    beneficiary: { id: number; name: string | null } | null;
  }>;
  billing_events: Array<{
    id: number;
    name: string | null;
    amount: string | null;
    /** The Billing Event's own status — never the purchase's. */
    status: string | null;
    /** The payment attempt's status (provider's, normalized) — never the purchase's. */
    payment_status: string | null;
    payment_method_name: string | null;
    paid_at: string | null;
    created_at: string;
  }>;
}

/** The member-facing shape of one purchase: no staff actor, channel or internal id. */
export function toMemberPurchaseView(p: MemberPurchase): MemberPurchaseView {
  return {
    id: p.id,
    name: p.name,
    status: p.status,
    created_at: p.created_at,
    total_amount: p.total_amount,
    initial_payment_amount: null,
    owner: { id: p.owner.id, name: p.owner.name },
    plans: p.plans.map((plan) => ({
      name: plan.name,
      status: plan.status,
      starts_at: plan.starts_at,
      beneficiaries: plan.beneficiaries,
      products: plan.products.map((l) => ({ name: l.name, quantity: l.quantity, beneficiary: l.beneficiary })),
    })),
    products: p.products.map((l) => ({
      kind: l.kind,
      name: l.name,
      billing_frequency: l.billing_frequency,
      quantity: l.quantity,
      beneficiary: l.beneficiary,
    })),
    billing_events: p.billing_events.map((e) => ({
      id: e.id,
      name: e.name,
      amount: e.amount,
      status: e.status,
      payment_status: e.payment_status,
      payment_method_name: e.payment_method_name,
      paid_at: e.paid_at,
      created_at: e.created_at,
    })),
  };
}

/**
 * #3495 — the Initial Payment of the member's open cart (`purchaseId`, status `in_cart`): computed by
 * the functions the cart's Summary and checkout use, so nothing is priced here. Null when it cannot be
 * computed (never 0, which would claim the cart owes nothing).
 */
export async function cartInitialPayment(gymId: string, ownerMemberId: number, purchaseId: number): Promise<string | null> {
  try {
    const { rows } = await db.query<any>(
      `SELECT id, status, owner_member_id, previous_product_set_id, starts_at
         FROM product_sets
        WHERE gym_id = ? AND purchase_id = ? AND status = 'in_cart'
        ORDER BY id DESC LIMIT 1`, [gymId, purchaseId]);
    let amount: number;
    if (rows[0]) {
      const { charge } = await commitCharge(gymId, rows[0]);
      amount = charge ? charge.amount : 0;
    } else {
      const cart = (await loadCartPurchases(db, gymId, ownerMemberId))
        .filter((c) => c.purchase_id == null || c.purchase_id === purchaseId);
      amount = cartTotal(cart);
    }
    return Number.isFinite(amount) && amount >= 0 ? (Math.round(amount * 100) / 100).toFixed(2) : null;
  } catch {
    return null;
  }
}

/** `limit` / `offset` of a request: integers in range, else a 400 message. */
export function parsePurchaseHistoryQuery(q: Record<string, unknown>):
  { ok: true; limit: number; offset: number } | { ok: false; error: string } {
  const read = (v: unknown, dflt: number): number | null => {
    if (v === undefined || v === '') return dflt;
    const s = String(v);
    return /^\d+$/.test(s) ? Number(s) : null;
  };
  const limit = read(q.limit, PURCHASE_HISTORY_DEFAULT_LIMIT);
  const offset = read(q.offset, 0);
  if (limit == null || limit < 1 || limit > PURCHASE_HISTORY_MAX_LIMIT) {
    return { ok: false, error: `limit must be an integer between 1 and ${PURCHASE_HISTORY_MAX_LIMIT}` };
  }
  if (offset == null) return { ok: false, error: 'offset must be a non-negative integer' };
  return { ok: true, limit, offset };
}

export const mePurchaseHistoryRouter = Router();

mePurchaseHistoryRouter.get('/', requireRole('member'), requireFeatureEnabled('member_web.my_membership'),
  async (req: Request, res: Response, next: NextFunction) => {
    const ctx = getTenantContext(req);
    const { gymId } = ctx;
    const parsed = parsePurchaseHistoryQuery(req.query as Record<string, unknown>);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    try {
      const memberId = await resolveMemberId(gymId, ctx);
      if (await refuseUnlessMayViewPayments(res, gymId, memberId)) return;
      const { items, total } = await loadMemberPurchases(gymId, memberId, parsed.limit, parsed.offset);
      const views = await Promise.all(items.map(async (p) => {
        const view = toMemberPurchaseView(p);
        if (p.status === 'in_cart') view.initial_payment_amount = await cartInitialPayment(gymId, p.owner.id, p.id);
        return view;
      }));
      res.json({ items: views, total, limit: parsed.limit, offset: parsed.offset });
    } catch (err) {
      next(err);
    }
  });
