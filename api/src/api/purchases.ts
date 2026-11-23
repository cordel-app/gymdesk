/**
 * #3251 — the one writer of `purchases`: a purchase is a cart (migration 465).
 *
 * A cart is started by the first thing put in it and holds:
 *   - a Product Set version (`product_sets.purchase_id`) — the plan, its lines and Promotions — and
 *   - one-time Product lines (`product_{session,oneoff}_snapshots.purchase_id`), in a set or standalone.
 *
 * The row's status is kept in step with what it holds by `syncPurchase()`, the one place that decides
 * it (`domain/purchaseStatus.ts`):
 *   - a payment in flight for anything in it makes it `pending_payment`, so the owner's next addition
 *     starts a new cart, and an owner has one cart `in_cart` at a time (`purchases_open_owner_key`):
 *     a cart returning to the cart (#1991) takes in whatever the owner had put in a newer one;
 *   - paying part of a standalone cart (`startCartCheckout()`) gives what is paid a purchase of its
 *     own (`splitOffCheckout()`); what stays in the cart keeps the cart;
 *   - a cart left with nothing in it while unconfirmed is deleted; a confirmed or cancelled one is
 *     kept, with its Billing Events, whatever happens to what it held.
 *
 * Nothing here creates a cart for a version the bridge makes to edit or retire a running plan, or for
 * a reprice: those are not checkouts (`createDraft(…, { purchase: false })`).
 */
import { beforeCommit, type Tx } from '../infra/db';
import { SYSTEM_ACTOR } from '../domain/auditActor';
import { CART_ITEM_STATUS, CartItemStatus, derivePurchaseStatus } from '../domain/purchaseStatus';

type Conn = Pick<Tx, 'query'>;

const LINE_TABLES = ['product_session_snapshots', 'product_oneoff_snapshots'] as const;

/** The owner's cart now `in_cart`, created when there is none. Locked. */
export async function openCart(tx: Conn, gymId: string, ownerMemberId: number, actorName: string | null): Promise<number> {
  const { rows } = await tx.query<{ id: number }>(
    `SELECT id FROM purchases WHERE gym_id = ? AND owner_member_id = ? AND status = 'in_cart' FOR UPDATE`,
    [gymId, ownerMemberId]);
  if (rows[0]) return Number(rows[0].id);
  return createPurchase(tx, gymId, ownerMemberId, 'in_cart', actorName);
}

/** A new cart in `status` (a checkout started outside the cart is `pending_payment` from birth). */
export async function createPurchase(
  tx: Conn, gymId: string, ownerMemberId: number, status: string, actorName: string | null,
): Promise<number> {
  const { insertId } = await tx.query(
    'INSERT INTO purchases (gym_id, owner_member_id, status, created_by) VALUES (?, ?, ?, ?)',
    [gymId, ownerMemberId, status, actorName ?? SYSTEM_ACTOR]);
  return Number(insertId);
}

/** The cart a Product Set belongs to, or null. */
export async function purchaseOfSet(tx: Conn, gymId: string, productSetId: number): Promise<number | null> {
  const { rows } = await tx.query<{ purchase_id: number | null }>(
    'SELECT purchase_id FROM product_sets WHERE id = ? AND gym_id = ?', [productSetId, gymId]);
  return rows[0]?.purchase_id == null ? null : Number(rows[0].purchase_id);
}

/** The carts the one-time line `lineId` (its `source_id`) belongs to: normally one, none for history. */
export async function purchasesOfLine(tx: Conn, gymId: string, lineId: number): Promise<number[]> {
  const ids = new Set<number>();
  for (const table of LINE_TABLES) {
    const { rows } = await tx.query<{ purchase_id: number | null }>(
      `SELECT purchase_id FROM ${table} WHERE gym_id = ? AND source_id = ? AND purchase_id IS NOT NULL`,
      [gymId, lineId]);
    for (const r of rows) ids.add(Number(r.purchase_id));
  }
  return [...ids];
}

/** Puts a one-time line in the cart `purchaseId` (a line added to a set joins the set's cart). */
export async function moveLineToPurchase(tx: Conn, gymId: string, lineId: number, purchaseId: number): Promise<void> {
  const previous = await purchasesOfLine(tx, gymId, lineId);
  for (const table of LINE_TABLES) {
    await tx.query(`UPDATE ${table} SET purchase_id = ? WHERE gym_id = ? AND source_id = ?`, [purchaseId, gymId, lineId]);
  }
  await touchPurchases(tx, gymId, [...previous, purchaseId]);
}

const touched = new WeakMap<object, Map<number, string>>();

/**
 * Marks carts whose contents a writer changed. Their status is settled once, just before the
 * transaction commits (`beforeCommit()`), from everything the transaction left in them: a Save & Pay
 * moves the lines before the set, and a sync after each step would read a half-moved cart. Outside a
 * `db.transaction()` the sync runs at once.
 */
export async function touchPurchases(tx: Conn, gymId: string, ids: Iterable<number | null | undefined>): Promise<void> {
  const list = [...ids].filter((id): id is number => id != null).map(Number);
  if (list.length === 0) return;
  let pending = touched.get(tx);
  if (!pending) {
    const fresh = new Map<number, string>();
    const registered = beforeCommit(tx, async () => {
      touched.delete(tx);
      for (const [id, gym] of fresh) await syncPurchase(tx, gym, id);
    });
    if (!registered) {
      for (const id of new Set(list)) await syncPurchase(tx, gymId, id);
      return;
    }
    touched.set(tx, fresh);
    pending = fresh;
  }
  for (const id of list) pending.set(id, gymId);
}

/**
 * A checkout of the one-time lines `lineIds` out of their cart: when the cart holds anything else
 * (the rest of the cart, or its Product Set), the lines move to a new purchase in `pending_payment`;
 * a cart that holds nothing else simply is the checkout. Answers the checkout's purchase.
 */
export async function splitOffCheckout(
  tx: Conn, gymId: string, ownerMemberId: number, lineIds: number[], actorName: string | null,
): Promise<number> {
  const carts = new Set<number>();
  for (const id of lineIds) for (const c of await purchasesOfLine(tx, gymId, id)) carts.add(c);
  const cartId = carts.size === 1 ? [...carts][0] : null;
  if (cartId != null) {
    const { rows } = await tx.query<{ n: number }>(
      `SELECT (SELECT COUNT(*) FROM product_sets WHERE gym_id = ? AND purchase_id = ?)
            + (SELECT COUNT(*) FROM product_session_snapshots WHERE gym_id = ? AND purchase_id = ? AND source_id NOT IN (${lineIds.map(() => '?').join(',')}))
            + (SELECT COUNT(*) FROM product_oneoff_snapshots WHERE gym_id = ? AND purchase_id = ? AND source_id NOT IN (${lineIds.map(() => '?').join(',')})) AS n`,
      [gymId, cartId, gymId, cartId, ...lineIds, gymId, cartId, ...lineIds]);
    if (Number(rows[0].n) === 0) return cartId;
  }
  const checkout = await createPurchase(tx, gymId, ownerMemberId, 'pending_payment', actorName);
  for (const id of lineIds) {
    for (const table of LINE_TABLES) {
      await tx.query(`UPDATE ${table} SET purchase_id = ? WHERE gym_id = ? AND source_id = ?`, [checkout, gymId, id]);
    }
  }
  await touchPurchases(tx, gymId, [...carts, checkout]);
  return checkout;
}

interface Member { kind: 'set' | 'line'; table: string; id: number; status: CartItemStatus | null }

async function loadMembers(tx: Conn, gymId: string, purchaseId: number): Promise<Member[]> {
  const members: Member[] = [];
  const { rows: sets } = await tx.query<{ id: number; status: string }>(
    'SELECT id, status FROM product_sets WHERE gym_id = ? AND purchase_id = ?', [gymId, purchaseId]);
  for (const s of sets) members.push({ kind: 'set', table: 'product_sets', id: Number(s.id), status: CART_ITEM_STATUS.set(s.status) });
  for (const table of LINE_TABLES) {
    const { rows } = await tx.query<{ id: number; status: string }>(
      `SELECT id, status FROM ${table} WHERE gym_id = ? AND purchase_id = ?`, [gymId, purchaseId]);
    for (const l of rows) members.push({ kind: 'line', table, id: Number(l.id), status: CART_ITEM_STATUS.line(l.status) });
  }
  return members;
}

async function moveMembers(tx: Conn, members: Member[], to: number): Promise<void> {
  for (const m of members) {
    await tx.query(`UPDATE ${m.table} SET purchase_id = ? WHERE id = ?`, [to, m.id]);
  }
}

async function writeStatus(tx: Conn, purchaseId: number, status: string): Promise<void> {
  await tx.query(
    `UPDATE purchases SET status = ?, modified_at = UTC_TIMESTAMP(), modified_by = ? WHERE id = ? AND status <> ?`,
    [status, SYSTEM_ACTOR, purchaseId, status]);
}

/**
 * Brings the cart `purchaseId` in step with what it holds (see the header). Idempotent; called by
 * every writer of a cart's contents after its change, in the same transaction.
 */
export async function syncPurchase(tx: Conn, gymId: string, purchaseId: number): Promise<void> {
  const { rows } = await tx.query<{ id: number; owner_member_id: number; status: string; created_by: string | null }>(
    'SELECT id, owner_member_id, status, created_by FROM purchases WHERE id = ? AND gym_id = ? FOR UPDATE',
    [purchaseId, gymId]);
  const cart = rows[0];
  if (!cart) return;
  const owner = Number(cart.owner_member_id);
  const members = (await loadMembers(tx, gymId, purchaseId)).filter((m) => m.status != null);

  if (members.length === 0) {
    // Unconfirmed and empty: the cart was cancelled, expired or emptied. A confirmed or cancelled
    // purchase stays, with the billing history that points at it.
    if (cart.status === 'in_cart' || cart.status === 'pending_payment') {
      await tx.query('DELETE FROM purchases WHERE id = ?', [purchaseId]);
    }
    return;
  }

  const status = derivePurchaseStatus(members.map((m) => m.status!));
  if (status === 'in_cart' && cart.status !== 'in_cart') {
    // Back in the cart (#1991): whatever the owner put in a newer cart meanwhile joins this one.
    const { rows: other } = await tx.query<{ id: number }>(
      `SELECT id FROM purchases WHERE gym_id = ? AND owner_member_id = ? AND status = 'in_cart' AND id <> ? FOR UPDATE`,
      [gymId, owner, purchaseId]);
    if (other[0]) {
      const otherId = Number(other[0].id);
      await moveMembers(tx, await loadMembers(tx, gymId, otherId), purchaseId);
      await tx.query('DELETE FROM purchases WHERE id = ?', [otherId]);
    }
  }
  await writeStatus(tx, purchaseId, status);
}
