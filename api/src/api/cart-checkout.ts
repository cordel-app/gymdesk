/**
 * #2949 stage 4 — a one-time Product in the member's cart no longer needs a Product Set.
 *
 * A standalone cart purchase is an `in_cart` purchase snapshot no Product Set carries (#1657 for staff,
 * and since this stage the Members App's `POST /me/cart/purchases` too). This module is the one place
 * several of them are paid **together**: `startCartCheckout()` takes every standalone `in_cart`
 * purchase of one member (or the ones named) and writes, in one transaction,
 *
 *   - one `product_purchase` Billing Event for their total, with one line per purchase restated from
 *     its frozen figures (`purchaseLine()`; nothing here prices anything),
 *   - one `payment_requests` row on that event (the hosted page's token, the provider order), and
 *   - each purchase moved `in_cart` → `pending_payment` and linked to the event through its
 *     `billing_event_{oneoff,session}_snapshots` junction, so it reaches its payment as any
 *     purchase does (`purchase-snapshots.ts`).
 *
 * The provider's confirmation completes every purchase of the request (`completeProductPurchase()`),
 * a failure or expiry cancels every one (`cancelProductPurchase()`, `cancelAbandonedPurchases()`), and
 * none of it touches a Product Set: a purchase a cart Product Set carries is paid by that set's Save &
 * Pay (#2746) and is never selected here.
 *
 * #2949 stage 5 — the member's Product Set checkout pays them too. A set's Save & Pay (staff or
 * member, every method) charges, beside the set's own lines, every standalone `in_cart` purchase of
 * its owner (`cartPurchasesForCharge()` → `InitialCharge.cartPurchaseIds`), and its initial Billing
 * Event **joins** exactly those (`joinCartPurchasesToEvent()`): each one moves `in_cart` →
 * `pending_payment` and is linked to the event through its `billing_event_{oneoff,session}_snapshots`
 * junction, never to the Product Set. From then on it follows the set's checkout
 * (`loadJoinedCartPurchases()` finds it through the set's events): activated with the set
 * (`activateSetPurchases()`), back in the cart when the checkout returns to Draft or is deleted
 * (`releaseJoinedCartPurchases(…, 'in_cart')`, its event link removed), cancelled with a cancelled
 * checkout. A purchase added to the cart after Save & Pay is not part of that checkout and stays in the
 * cart.
 *
 * The amounts are the purchases' frozen ones (`resolvePurchase()` priced each when it entered the
 * cart): a cart is paid at the price it shows, exactly as a cart Product Set's linked purchases are.
 */
import { splitOffCheckout, stampEventPurchase } from './purchases';
import crypto from 'crypto';
import { db, type Tx } from '../infra/db';
import { getPaymentProvider } from '../payments';
import { toMinorUnits } from '../payments/money';
import { withPurposeParam } from '../domain/storedCards';
import {
  IN_CART_PURCHASE_STATUS, PENDING_PURCHASE_STATUS, PRODUCT_PURCHASE_SOURCE,
} from '../domain/memberProductPurchase';
import { SYSTEM_ACTOR } from '../domain/auditActor';
import { cartExpiresAtIso, lineCartLiveSql } from '../domain/cartExpiry';
import { lineFromSimulation, type BillingEventLineRow } from '../domain/billingEventLines';
import type { SimulationLine } from '../domain/billingSimulation';
import { resolvePayerFor } from './payer-resolution';
import { recordPaymentAttempt } from './payment-attempt';
import { payerCheckoutUrl } from './checkout-url';
import { deletePurchase, lockPurchase, purchaseSnapshotTable, updatePurchase } from './purchase-writer';
import { PURCHASE_EVENT_JUNCTIONS } from './snapshot-junction-sync';
import { purchaseSnapshotParams, purchaseSnapshotsSql } from './purchase-snapshots';
import { cartPurchaseEventNameFor } from './billing-event-name';
import { writeLines } from './product-set-checkout';

type Conn = Pick<Tx, 'query'>;

const ER_DUP_ENTRY = 1062;

/** One standalone purchase in the member's cart, as the checkout needs it. */
export interface CartPurchase {
  id: number;
  product_id: number | null;
  product_name: string;
  product_type: string | null;
  /** The total (unit price x quantity); `unit_amount` is one unit's (#3020 stage 5). */
  amount: number;
  unit_amount: number;
  quantity: number;
  list_price: number | null;
  currency: string;
  tax_rate_percent: number | null;
  assigned_member_id: number | null;
  created_at: string | null;
  /** #3251 stage 3: the cart (`purchases`) the line is in, when the read selected it. */
  purchase_id?: number | null;
  /** #3274: the cart's one expiry (its purchase's `expires_at`), when the read selected it. */
  cart_expires_at?: string | null;
}

/** A refusal the routes answer as `{ status, error }`. */
export class CartCheckoutRefused extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

/**
 * The member's standalone `in_cart` purchases (none a Product Set carries), oldest first. The
 * caller runs `expireCarts()` for the member first, so an expired cart is never listed or paid.
 */
export async function loadCartPurchases(exec: Conn, gymId: string, memberId: number): Promise<CartPurchase[]> {
  // #3274: one in a cart past its expiry (its purchase's `expires_at`) is never listed or paid, even
  // before the sweep deleted it.
  const { rows } = await exec.query<any>(
    `SELECT mp.id, mp.product_id, mp.product_name, mp.product_type, mp.amount, mp.unit_amount, mp.quantity, mp.list_price, mp.currency,
            mp.tax_rate_percent, mp.assigned_member_id, mp.created_at, mp.purchase_id, mp.cart_expires_at
       FROM ${purchaseSnapshotsSql(
         `gym_id = ? AND member_id = ? AND status = ? AND ${lineCartLiveSql('purchase_id')}`,
         { notInProductSet: true })} mp
      ORDER BY mp.created_at, mp.id`,
    purchaseSnapshotParams([gymId, memberId, IN_CART_PURCHASE_STATUS]),
  );
  return rows.map(toCartPurchase);
}

/**
 * #2967 — cancelling the cart removes its standalone In Cart one-time purchases too (they have
 * charged nothing, so a hard delete, as the member's own removal does). Only this member's
 * standalone ones: purchases of a cart Product Set go with that set, and active ones are untouched.
 */
export async function deleteStandaloneCartPurchases(tx: Tx, gymId: string, memberId: number): Promise<number> {
  let n = 0;
  for (const p of await loadCartPurchases(tx, gymId, memberId)) {
    if (await lockPurchase(tx, gymId, memberId, p.id)
      && await deletePurchase(tx, gymId, p.id, { memberId, status: IN_CART_PURCHASE_STATUS })) n++;
  }
  return n;
}

function toCartPurchase(r: any): CartPurchase {
  return {
    id: Number(r.id),
    product_id: r.product_id == null ? null : Number(r.product_id),
    product_name: String(r.product_name),
    product_type: r.product_type ?? null,
    amount: Number(r.amount ?? 0),
    unit_amount: Number(r.unit_amount ?? r.amount ?? 0),
    quantity: Number(r.quantity ?? 1),
    list_price: r.list_price == null ? null : Number(r.list_price),
    currency: String(r.currency ?? 'EUR'),
    tax_rate_percent: r.tax_rate_percent == null ? null : Number(r.tax_rate_percent),
    assigned_member_id: r.assigned_member_id == null ? null : Number(r.assigned_member_id),
    created_at: r.created_at == null ? null : new Date(r.created_at).toISOString(),
    ...(r.purchase_id !== undefined ? { purchase_id: r.purchase_id == null ? null : Number(r.purchase_id) } : {}),
    ...(r.cart_expires_at !== undefined ? { cart_expires_at: cartExpiresAtIso(r.cart_expires_at) } : {}),
  };
}

/** A purchase's line on the checkout's Billing Event: its frozen amount, restated. */
export function purchaseLine(p: CartPurchase): BillingEventLineRow {
  return cartChargeLine(p).line;
}

/** The same line in the simulation's own shape too, for a Product Set's initial charge (stage 5). */
export function cartChargeLine(p: CartPurchase): { simulation: SimulationLine; line: BillingEventLineRow } {
  const simulation: SimulationLine = {
    kind: 'product', source: 'product', label: p.product_name, user_membership_id: 0, plan_name: null,
    product_id: p.product_id, quantity: p.quantity, unit_price: p.unit_amount, regular_price: p.list_price ?? p.unit_amount,
    benefits: [], actual_charge: p.amount, price_may_change: false, prepaid_periods: null,
  };
  const line = {
    ...lineFromSimulation(simulation, { taxRatePercent: p.tax_rate_percent, taxBehavior: 'inclusive' }),
    item_type: p.product_type,
  };
  return { simulation, line };
}

/** Cents-exact total of the purchases (each amount is a two-decimal euro figure). */
export function cartTotal(purchases: Pick<CartPurchase, 'amount'>[]): number {
  return purchases.reduce((cents, p) => cents + Math.round(p.amount * 100), 0) / 100;
}

/**
 * Which purchases a checkout pays: every one in the cart, or exactly the ones named (all of which
 * must be in it). Pure, so the refusals are decided in one place.
 */
export function selectCartPurchases(
  cart: CartPurchase[], requested: number[] | null,
): { ok: true; purchases: CartPurchase[] } | { ok: false; status: number; code: string; message: string } {
  const chosen = requested == null ? cart : cart.filter((p) => requested.includes(p.id));
  if (requested != null && chosen.length !== new Set(requested).size) {
    return { ok: false, status: 404, code: 'purchase_not_in_cart', message: 'A named purchase is not in the cart' };
  }
  if (chosen.length === 0) return { ok: false, status: 409, code: 'cart_empty', message: 'There is nothing in the cart to pay' };
  if (new Set(chosen.map((p) => p.currency)).size > 1) {
    return { ok: false, status: 400, code: 'mixed_currency', message: 'The cart holds more than one currency' };
  }
  if (cartTotal(chosen) <= 0) {
    return { ok: false, status: 409, code: 'nothing_to_pay', message: 'The cart total is zero' };
  }
  return { ok: true, purchases: chosen };
}

export interface CartCheckoutResult {
  purchaseIds: number[];
  billingEventId: number;
  checkoutUrl: string;
  amount: number;
  currency: string;
}

/**
 * Starts one payment for the member's standalone cart purchases (all, or `purchaseIds`). See the
 * header. The provider payment is created before the transaction (as `startProductPurchase()` does);
 * inside it every purchase is locked and re-checked, so one removed, expired or paid in between
 * refuses the whole checkout and nothing is written.
 */
export async function startCartCheckout(input: {
  gymId: string;
  memberId: number;
  memberEmail: string;
  actorName: string | null;
  purchaseIds?: number[] | null;
  requestLocale?: string;
}): Promise<CartCheckoutResult> {
  const { gymId, memberId } = input;
  const selected = selectCartPurchases(await loadCartPurchases(db, gymId, memberId), input.purchaseIds ?? null);
  if (!selected.ok) throw new CartCheckoutRefused(selected.status, selected.code, selected.message);
  const purchases = selected.purchases;
  const amount = cartTotal(purchases);
  const currency = purchases[0].currency;
  const names = purchases.map((p) => p.product_name);

  // The payment's charge type: the Products' own when they agree, else none (a mixed cart).
  const productIds = purchases.map((p) => p.product_id).filter((id): id is number => id != null);
  let chargeTypeId: number | null = null;
  if (productIds.length === purchases.length) {
    const { rows } = await db.query<{ charge_type_id: number | null }>(
      `SELECT DISTINCT charge_type_id FROM products WHERE gym_id = ? AND id IN (${productIds.map(() => '?').join(', ')})`,
      [gymId, ...productIds]);
    if (rows.length === 1 && rows[0].charge_type_id != null) chargeTypeId = Number(rows[0].charge_type_id);
  }

  const orderId = crypto.randomUUID();
  const pageToken = crypto.randomUUID();
  const pageTokenExpires = new Date(Date.now() + 10 * 60 * 1000);
  const result = await getPaymentProvider().createPaymentRequest({
    orderId,
    amount: toMinorUnits(amount),
    currency,
    description: names.join(', ').slice(0, 250),
    memberEmail: input.memberEmail,
    okUrl: withPurposeParam(process.env.PAYMENT_OK_URL ?? '', 'product_purchase'),
    koUrl: withPurposeParam(process.env.PAYMENT_KO_URL ?? '', 'product_purchase'),
    notificationUrl: process.env.PAYMENT_NOTIFICATION_URL ?? '',
  });
  // #2123: the Family Owner pays (no card is stored from a one-time purchase).
  const payer = await resolvePayerFor(db, gymId, memberId);

  try {
    const billingEventId = await db.transaction(async (tx) => {
      for (const p of purchases) {
        if (!(await lockPurchase(tx, gymId, memberId, p.id))) {
          throw new CartCheckoutRefused(409, 'cart_changed', 'The cart changed; read it again');
        }
      }
      const fresh = await loadCartPurchases(tx, gymId, memberId);
      if (purchases.some((p) => !fresh.some((f) => f.id === p.id && f.amount === p.amount))) {
        throw new CartCheckoutRefused(409, 'cart_changed', 'The cart changed; read it again');
      }

      // #3251: the lines paid are one checkout; what stays in the cart keeps the cart.
      const checkoutId = await splitOffCheckout(tx, gymId, memberId, purchases.map((p) => p.id), input.actorName);
      const { insertId: paymentRequestId } = await tx.query(
        `INSERT INTO payment_requests
           (gym_id, anchor_plan_snapshot_id, member_id, payer_member_id, amount, currency, charge_type_id,
            status, provider, provider_order, provider_ref, page_token, page_token_expires,
            consent_given_at, source, created_by)
         VALUES (?, NULL, ?, ?, ?, ?, ?, 'pending', 'monei', ?, ?, ?, ?, UTC_TIMESTAMP(), ?, ?)`,
        [gymId, memberId, payer.payerMemberId, amount.toFixed(2), currency, chargeTypeId,
          orderId, result.providerOrderId, pageToken, pageTokenExpires, PRODUCT_PURCHASE_SOURCE, input.actorName],
      );
      const eventName = await cartPurchaseEventNameFor(tx, gymId, names, new Date().toISOString().slice(0, 10));
      const { insertId: eventId } = await tx.query(
        `INSERT INTO billing_events
           (gym_id, member_id, payer_member_id, event_type, name, amount, charge_type_id, source, created_by)
         VALUES (?, ?, ?, 'product_purchase', ?, ?, ?, 'provider', ?)`,
        [gymId, memberId, payer.payerMemberId, eventName, amount.toFixed(2), chargeTypeId, input.actorName],
      );
      await tx.query('UPDATE payment_requests SET billing_event_id = ? WHERE id = ? AND gym_id = ?',
        [eventId, paymentRequestId, gymId]);
      await recordPaymentAttempt(tx, paymentRequestId);
      await writeLines(tx as Tx, gymId, Number(eventId), purchases.map(purchaseLine));
      // #3251 stage 2: the checkout's Billing Event is its purchase's.
      await stampEventPurchase(tx, gymId, Number(eventId), checkoutId);

      for (const p of purchases) {
        const moved = await updatePurchase(tx, gymId, p.id, { status: PENDING_PURCHASE_STATUS },
          input.actorName ?? 'System', { fromStatus: IN_CART_PURCHASE_STATUS });
        if (moved === 0) throw new CartCheckoutRefused(409, 'cart_changed', 'The cart changed; read it again');
        const table = purchaseSnapshotTable(p.product_type);
        const j = PURCHASE_EVENT_JUNCTIONS.find((x) => x.table === table)!;
        await tx.query(
          `INSERT IGNORE INTO ${j.junction} (billing_event_id, ${j.snapshotCol})
           SELECT ?, s.id FROM ${table} s WHERE s.gym_id = ? AND s.source_id = ?`,
          [eventId, gymId, p.id]);
      }
      return Number(eventId);
    });

    return {
      purchaseIds: purchases.map((p) => p.id),
      billingEventId,
      checkoutUrl: await payerCheckoutUrl({ gymId, memberId, pageToken, requestLocale: input.requestLocale }),
      amount,
      currency,
    };
  } catch (err: any) {
    // The pending key: the member already has one of these Products awaiting payment.
    if (err?.errno === ER_DUP_ENTRY) throw new CartCheckoutRefused(409, 'purchase_pending', 'A Product in the cart is already awaiting payment');
    throw err;
  }
}

// ── #2949 stage 5: standalone cart purchases paid by a Product Set's checkout ────────────────────

/** The arm's Product Set junction: a purchase linked there is the set's own (#2746), never joined here. */
const SET_JUNCTION_OF: Record<string, { junction: string; col: string }> = {
  product_oneoff_snapshots: { junction: 'product_set_oneoff_snapshots', col: 'product_oneoff_snapshot_id' },
  product_session_snapshots: { junction: 'product_set_session_snapshots', col: 'product_session_snapshot_id' },
};

export interface JoinedCartPurchase extends CartPurchase {
  status: string;
  member_id: number;
  snapshot_id: number;
  snapshot_table: string;
}

/**
 * The standalone purchases a Product Set's checkout pays: linked to one of the set's Billing Events
 * through the event junction, and to no Product Set. Oldest first.
 */
export async function loadJoinedCartPurchases(exec: Conn, gymId: string, productSetId: number): Promise<JoinedCartPurchase[]> {
  const out: JoinedCartPurchase[] = [];
  for (const j of PURCHASE_EVENT_JUNCTIONS) {
    const set = SET_JUNCTION_OF[j.table];
    const { rows } = await exec.query<any>(
      `SELECT DISTINCT s.source_id AS id, s.id AS snapshot_id, s.member_id, s.status, s.product_id, s.product_name,
              s.product_type, s.unit_price AS amount, s.list_price, s.currency, s.tax_rate_percent,
              s.assigned_member_id, s.created_at
         FROM ${j.junction} bj
         JOIN billing_events be ON be.id = bj.billing_event_id AND be.gym_id = ? AND be.product_set_id = ?
         JOIN ${j.table} s ON s.id = bj.${j.snapshotCol} AND s.gym_id = be.gym_id
        WHERE s.source_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM ${set.junction} psj_ WHERE psj_.${set.col} = s.id)`,
      [gymId, productSetId]);
    for (const r of rows) {
      out.push({
        ...toCartPurchase(r), status: String(r.status), member_id: Number(r.member_id),
        snapshot_id: Number(r.snapshot_id), snapshot_table: j.table,
      });
    }
  }
  return out.sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) || a.id - b.id);
}

/**
 * The standalone purchases a Product Set's initial charge includes: while the set is in the cart,
 * every standalone `in_cart` purchase of its owner; once its checkout exists, the ones that checkout
 * joined and has not settled.
 */
export async function cartPurchasesForCharge(exec: Conn, gymId: string, productSetId: number): Promise<CartPurchase[]> {
  const { rows } = await exec.query<{ status: string; owner_member_id: number }>(
    'SELECT status, owner_member_id FROM product_sets WHERE id = ? AND gym_id = ?', [productSetId, gymId]);
  const set = rows[0];
  if (!set) return [];
  if (set.status === 'in_cart') {
    return (await loadCartPurchases(exec, gymId, Number(set.owner_member_id))).filter((p) => p.amount > 0);
  }
  return (await loadJoinedCartPurchases(exec, gymId, productSetId))
    .filter((p) => p.status === IN_CART_PURCHASE_STATUS || p.status === PENDING_PURCHASE_STATUS);
}

/**
 * Joins the named standalone purchases to a Product Set's initial Billing Event (see the header):
 * each one is locked, re-checked (the owner's, standalone, still `in_cart` and at the amount charged)
 * and moved to `pending_payment` with its event link. One already joined to this event is left as
 * it is, so a reused event is idempotent. Anything else refuses the whole checkout (`cart_changed`).
 */
export async function joinCartPurchasesToEvent(tx: Conn, input: {
  gymId: string; productSetId: number; billingEventId: number; purchases: Pick<CartPurchase, 'id' | 'amount'>[]; actor: string | null;
}): Promise<void> {
  if (input.purchases.length === 0) return;
  const { gymId } = input;
  const { rows: setRows } = await tx.query<{ owner_member_id: number }>(
    'SELECT owner_member_id FROM product_sets WHERE id = ? AND gym_id = ?', [input.productSetId, gymId]);
  const ownerId = Number(setRows[0]?.owner_member_id);
  const changed = () => new CartCheckoutRefused(409, 'cart_changed', 'The cart changed; read it again');

  const joined = new Set((await loadJoinedCartPurchases(tx, gymId, input.productSetId)).map((p) => p.id));
  for (const p of input.purchases) {
    if (joined.has(p.id)) continue;
    if (!(await lockPurchase(tx, gymId, ownerId, p.id))) throw changed();
  }
  const cart = await loadCartPurchases(tx, gymId, ownerId);
  for (const p of input.purchases) {
    if (joined.has(p.id)) continue;
    const fresh = cart.find((c) => c.id === p.id);
    if (!fresh || fresh.amount !== p.amount) throw changed();
    let moved: number;
    try {
      moved = await updatePurchase(tx, gymId, p.id, { status: PENDING_PURCHASE_STATUS },
        input.actor ?? SYSTEM_ACTOR, { fromStatus: IN_CART_PURCHASE_STATUS });
    } catch (err: any) {
      if (err?.errno === ER_DUP_ENTRY) throw new CartCheckoutRefused(409, 'purchase_pending', 'A Product in the cart is already awaiting payment');
      throw err;
    }
    if (moved === 0) throw changed();
    const table = purchaseSnapshotTable(fresh.product_type);
    const j = PURCHASE_EVENT_JUNCTIONS.find((x) => x.table === table)!;
    await tx.query(
      `INSERT IGNORE INTO ${j.junction} (billing_event_id, ${j.snapshotCol})
       SELECT ?, s.id FROM ${table} s WHERE s.gym_id = ? AND s.source_id = ?`,
      [input.billingEventId, gymId, p.id]);
  }
}

/**
 * The checkout that joined these purchases is over without paying them: `in_cart` puts each pending
 * one back in the cart as a standalone purchase (its event link removed: the checkout returned to
 * Draft or was deleted), `cancelled` cancels it with a cancelled checkout (the link kept, as the
 * set's own purchases keep theirs).
 */
export async function releaseJoinedCartPurchases(
  tx: Conn, gymId: string, productSetId: number, to: 'in_cart' | 'cancelled', actor: string = SYSTEM_ACTOR,
): Promise<number> {
  let released = 0;
  for (const p of await loadJoinedCartPurchases(tx, gymId, productSetId)) {
    if (p.status !== PENDING_PURCHASE_STATUS) continue;
    if (to === 'in_cart') {
      const j = PURCHASE_EVENT_JUNCTIONS.find((x) => x.table === p.snapshot_table)!;
      await tx.query(
        `DELETE bj FROM ${j.junction} bj JOIN billing_events be ON be.id = bj.billing_event_id
          WHERE bj.${j.snapshotCol} = ? AND be.gym_id = ? AND be.product_set_id = ?`,
        [p.snapshot_id, gymId, productSetId]);
    }
    released += await updatePurchase(tx, gymId, p.id,
      { status: to === 'in_cart' ? IN_CART_PURCHASE_STATUS : 'cancelled' }, actor, { fromStatus: PENDING_PURCHASE_STATUS });
  }
  return released;
}
