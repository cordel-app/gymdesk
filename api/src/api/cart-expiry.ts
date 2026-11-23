import { db, type Tx } from '../infra/db';
import { purchaseCartExpiredSql } from '../domain/cartExpiry';
import { cancelInFlight } from './product-sets';
import { deletePurchase } from './purchase-writer';
import { syncPurchase } from './purchases';

/**
 * #3274 — the one In-Cart expiry sweep: a cart (`purchases` row in `in_cart`) past its
 * `expires_at` is expired as a whole, whatever it holds.
 *
 * Expiring a cart is exactly what **Cancel** does to it, and nothing more: its Product Set Draft is
 * discarded through `cancelInFlight()` (the Draft's own plan snapshots, lines and Draft assignment;
 * the plans it marked for cancellation or reactivation run on as they were; a snapshot another set
 * links is kept), and every one-time line still in the cart is deleted through `deletePurchase()`.
 * Nothing confirmed is touched: no Billing Event, payment, completed purchase, Active or Superseded
 * set, or other purchase. The emptied, unconfirmed purchase row is then deleted (`syncPurchase()`).
 *
 * A Pending Payment, completed or cancelled purchase is never selected: #1991's Pending Payment
 * timeout (`expirePendingPayments()`) and the payment-request expiry stay separate.
 */

/** #2962 — one one-time line the expiry deleted. */
export interface ExpiredPurchaseDraft { id: number; gymId: string; memberId: number }

export interface ExpiredCart {
  /** Whether the cart was expired (false: it was changed, paid or emptied in between). */
  expired: boolean;
  /** Product Set Drafts the cart held. */
  productSets: number;
  /** One-time lines the cart held. */
  lines: ExpiredPurchaseDraft[];
}

const LINE_TABLES = ['product_session_snapshots', 'product_oneoff_snapshots'] as const;

/**
 * Expires the cart `purchaseId` inside `tx`, re-checking under its locks. Locks in the order an edit
 * takes them — the cart's Product Set, then its lines, then the purchase — so a racing edit either
 * refreshed the clock first (and the re-check leaves the cart alone) or waits and finds it gone; a
 * racing checkout has moved the purchase out of `in_cart` and is left alone the same way.
 */
export async function expireCartInTx(tx: Tx, gymId: string, purchaseId: number): Promise<ExpiredCart> {
  const none: ExpiredCart = { expired: false, productSets: 0, lines: [] };
  const { rows: sets } = await tx.query<{ id: number }>(
    `SELECT id FROM product_sets WHERE gym_id = ? AND purchase_id = ? AND status = 'in_cart' ORDER BY id FOR UPDATE`,
    [gymId, purchaseId]);
  const lines: ExpiredPurchaseDraft[] = [];
  for (const table of LINE_TABLES) {
    const { rows } = await tx.query<{ source_id: number; member_id: number }>(
      `SELECT source_id, member_id FROM ${table}
        WHERE gym_id = ? AND purchase_id = ? AND status = 'in_cart' AND source_id IS NOT NULL FOR UPDATE`,
      [gymId, purchaseId]);
    for (const r of rows) lines.push({ id: Number(r.source_id), gymId, memberId: Number(r.member_id) });
  }
  const { rows: cart } = await tx.query<{ id: number }>(
    `SELECT id FROM purchases WHERE id = ? AND gym_id = ? AND ${purchaseCartExpiredSql('purchases')} FOR UPDATE`,
    [purchaseId, gymId]);
  if (!cart[0]) return none;

  for (const s of sets) await cancelInFlight(tx, gymId, Number(s.id));
  for (const l of lines) await deletePurchase(tx, gymId, l.id, { memberId: l.memberId, status: 'in_cart' });
  // Settled now rather than at commit, so a caller opening the owner's next cart in this same
  // transaction (`openCart()`) does not meet this one under `purchases_open_owner_key`.
  await syncPurchase(tx, gymId, purchaseId);
  return { expired: true, productSets: sets.length, lines };
}

export interface ExpiredCarts { carts: number; productSets: number; lines: ExpiredPurchaseDraft[] }

/**
 * Expires every cart past its time — the deployment's (`POST /billing/cleanup`, the 15-minute
 * reminders pass) or one owner's, which every cart read, write and checkout of that owner runs first
 * so an expired cart is never listed, edited or paid even before a sweep. One transaction per cart,
 * so a failure leaves the others (and a retry) intact; idempotent and safe under concurrent runs.
 */
export async function expireCarts(scope: { gymId: string; ownerMemberId: number } | null = null): Promise<ExpiredCarts> {
  const { rows } = await db.query<{ id: number; gym_id: string }>(
    `SELECT p.id, p.gym_id FROM purchases p
      WHERE ${purchaseCartExpiredSql('p')}${scope ? ' AND p.gym_id = ? AND p.owner_member_id = ?' : ''}
      ORDER BY p.id`,
    scope ? [scope.gymId, scope.ownerMemberId] : []);
  const out: ExpiredCarts = { carts: 0, productSets: 0, lines: [] };
  for (const r of rows) {
    const one = await db.transaction((tx) => expireCartInTx(tx, r.gym_id, Number(r.id)))
      .catch((err) => { console.error(`expireCarts: purchase ${r.id} failed`, err); return null; });
    if (!one?.expired) continue;
    out.carts += 1;
    out.productSets += one.productSets;
    out.lines.push(...one.lines);
  }
  return out;
}
