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
import { CART_EXPIRES_AT_SQL, cartClockSql, purchaseCartExpiredSql } from '../domain/cartExpiry';
import { currentRequestChannel, currentRequestLocale } from '../infra/requestChannel';
import { canonicalPurchaseName, contentsPurchaseName, type PurchaseContents } from '../domain/purchaseName';
import { DEFAULT_GYM_LOCALIZATION } from '../domain/gymLocalization';

type Conn = Pick<Tx, 'query'>;

const LINE_TABLES = ['product_session_snapshots', 'product_oneoff_snapshots'] as const;
/** #3251 stage 2: rows that record the cart they were written in, without being what the cart holds. */
const STAMPED_TABLES = ['plan_snapshots', 'product_periodical_snapshots', 'billing_events'] as const;

/**
 * The owner's cart now `in_cart`, created when there is none. Locked. #3274: a cart past its two
 * hours is expired as a whole first (`expireCartInTx()`), so nothing is ever added to a cart whose
 * time is up and the owner gets a new one.
 */
export async function openCart(tx: Conn, gymId: string, ownerMemberId: number, actorName: string | null): Promise<number> {
  const { rows } = await tx.query<{ id: number; expired: number }>(
    `SELECT id, ${purchaseCartExpiredSql('purchases')} AS expired
       FROM purchases WHERE gym_id = ? AND owner_member_id = ? AND status = 'in_cart' FOR UPDATE`,
    [gymId, ownerMemberId]);
  if (rows[0] && Number(rows[0].expired) !== 1) return Number(rows[0].id);
  if (rows[0]) {
    const { expireCartInTx } = await import('./cart-expiry');
    await expireCartInTx(tx as Tx, gymId, Number(rows[0].id));
    const { rows: still } = await tx.query<{ id: number }>(
      `SELECT id FROM purchases WHERE gym_id = ? AND owner_member_id = ? AND status = 'in_cart' FOR UPDATE`,
      [gymId, ownerMemberId]);
    if (still[0]) return Number(still[0].id);
  }
  return createPurchase(tx, gymId, ownerMemberId, 'in_cart', actorName);
}

/**
 * #3274 — a change of the cart `purchaseId`'s contents moves its one clock two hours ahead. A cart
 * already past its time is not revived (the sweep or the next guard expires it), and a purchase not
 * `in_cart` has no clock to move. Answers whether the cart is live after the call.
 */
export async function refreshCart(tx: Conn, gymId: string, purchaseId: number | null | undefined): Promise<boolean> {
  if (purchaseId == null) return true;
  const { rowCount } = await tx.query(
    `UPDATE purchases SET expires_at = ${CART_EXPIRES_AT_SQL}
      WHERE id = ? AND gym_id = ? AND status = 'in_cart' AND ${cartClockSql('purchases')} > UTC_TIMESTAMP()`,
    [purchaseId, gymId]);
  return rowCount > 0;
}

/** `refreshCart()` for the cart the Product Set `productSetId` belongs to (none for a set no checkout made). */
export async function refreshSetCart(tx: Conn, gymId: string, productSetId: number): Promise<boolean> {
  return refreshCart(tx, gymId, await purchaseOfSet(tx, gymId, productSetId));
}

/** #3288: a purchase's canonical name and creation instant, decided before the row exists. */
export interface PlannedPurchaseName { createdAt: Date; name: string }

/**
 * #3288 — the canonical name a purchase created at `createdAt` gets (`domain/purchaseName.ts`): the
 * gym's current name and Time & Localization, and the language of the request creating it. Exported
 * so a checkout that must send the name to the payment provider before its purchase exists can plan
 * both and hand them to `createPurchase()`.
 */
export async function planPurchaseName(
  exec: Conn, gymId: string, createdAt: Date = new Date(),
): Promise<PlannedPurchaseName> {
  const at = new Date(Math.floor(createdAt.getTime() / 1000) * 1000);
  const { rows } = await exec.query<any>(
    'SELECT name, time_zone, date_format, time_format FROM gyms WHERE id = ?', [gymId]);
  const g = rows[0] ?? {};
  const name = canonicalPurchaseName({
    gymName: g.name, locale: currentRequestLocale(), createdAt: at,
    settings: {
      time_zone: g.time_zone ?? DEFAULT_GYM_LOCALIZATION.time_zone,
      date_format: g.date_format ?? DEFAULT_GYM_LOCALIZATION.date_format,
      time_format: g.time_format ?? DEFAULT_GYM_LOCALIZATION.time_format,
    },
  });
  return { createdAt: at, name };
}

/**
 * A new cart in `status` (a checkout started outside the cart is `pending_payment` from birth).
 * #3278: `created_by` (who) and `channel` (which application, from the route the server is
 * answering, `infra/requestChannel.ts`) are written here once and never updated, so editing,
 * paying, expiring or recovering the cart, or merging a newer cart into it, keeps both.
 * #3288: so is the canonical `name`, generated from the very instant written as `created_at`
 * (`planned`, when the caller already sent that name to the provider, else now).
 */
export async function createPurchase(
  tx: Conn, gymId: string, ownerMemberId: number, status: string, actorName: string | null,
  planned?: PlannedPurchaseName,
): Promise<number> {
  const { createdAt, name } = planned ?? await planPurchaseName(tx, gymId);
  const { insertId } = await tx.query(
    // #3274: a cart opened now has two hours; a checkout started outside the cart has no cart clock.
    // #3307 stage 2: a purchase born completed (a free one-time line) is stamped as paid now.
    `INSERT INTO purchases (gym_id, owner_member_id, status, expires_at, completed_at, name, created_at, created_by, channel)
     VALUES (?, ?, ?, IF(? = 'in_cart', ${CART_EXPIRES_AT_SQL}, NULL), IF(? = 'completed', UTC_TIMESTAMP(), NULL), ?, ?, ?, ?)`,
    [gymId, ownerMemberId, status, status, status, name, createdAt, actorName ?? SYSTEM_ACTOR, currentRequestChannel()]);
  return Number(insertId);
}

/**
 * #3553 — what a checkout pays for, by name: the Product Set's plans it does not carry over unchanged
 * from the previous version and its recurring lines it adds, the one-time lines (`lineIds`, else every
 * line of the cart), and what it cancels (a plan marked for cancellation, a Product line the cart ends
 * earlier than the line it was copied from). A plan's included Products are its plan's, never counted.
 */
export async function loadPurchaseContents(
  exec: Conn, gymId: string, opts: { productSetId?: number | null; purchaseId?: number | null; lineIds?: number[] },
): Promise<PurchaseContents> {
  const contents: PurchaseContents = { plans: [], products: [], cancelledPlans: [], cancelledProducts: [] };
  const setId = opts.productSetId ?? null;
  if (setId != null) {
    const { rows: plans } = await exec.query<{ name: string; status: string; carried: number }>(
      `SELECT COALESCE(mp.name, '') AS name, s.status,
              EXISTS (SELECT 1 FROM product_sets cur JOIN product_set_plan_snapshots pj ON pj.product_set_id = cur.previous_product_set_id
                       WHERE cur.id = j.product_set_id AND pj.plan_snapshot_id = s.id) AS carried
         FROM product_set_plan_snapshots j
         JOIN plan_snapshots s ON s.id = j.plan_snapshot_id
         LEFT JOIN membership_plans mp ON mp.id = s.membership_plan_id
        WHERE j.product_set_id = ? AND s.gym_id = ? AND j.entitlement_only = 0
        ORDER BY j.id`, [setId, gymId]);
    for (const p of plans) {
      if (p.status === 'to_be_canceled' || p.status === 'to_be_canceled_immediately') contents.cancelledPlans.push(String(p.name));
      else if (Number(p.carried) === 0) contents.plans.push(String(p.name));
    }
    const { rows: lines } = await exec.query<{ name: string; carried: number; cancelled: number }>(
      `SELECT l.product_name AS name,
              (l.copied_from_periodical_snapshot_id IS NOT NULL OR EXISTS (
                 SELECT 1 FROM product_sets cur JOIN product_set_periodical_snapshots pl ON pl.product_set_id = cur.previous_product_set_id
                  WHERE cur.id = j.product_set_id AND pl.product_periodical_snapshot_id = l.id)) AS carried,
              (src.id IS NOT NULL AND l.ends_at IS NOT NULL AND (src.ends_at IS NULL OR src.ends_at > l.ends_at)) AS cancelled
         FROM product_set_periodical_snapshots j
         JOIN product_periodical_snapshots l ON l.id = j.product_periodical_snapshot_id
         LEFT JOIN product_periodical_snapshots src ON src.id = l.copied_from_periodical_snapshot_id
        WHERE j.product_set_id = ? AND l.gym_id = ?
        ORDER BY j.id`, [setId, gymId]);
    for (const l of lines) {
      if (Number(l.cancelled) === 1) contents.cancelledProducts.push(String(l.name));
      else if (Number(l.carried) === 0) contents.products.push(String(l.name));
    }
  }
  const lineIds = opts.lineIds ?? [];
  if (lineIds.length > 0 || opts.purchaseId != null) {
    for (const table of LINE_TABLES) {
      const where = lineIds.length > 0
        ? `source_id IN (${lineIds.map(() => '?').join(', ')})` : 'purchase_id = ?';
      const { rows } = await exec.query<{ name: string }>(
        `SELECT product_name AS name FROM ${table} WHERE gym_id = ? AND ${where} ORDER BY source_id`,
        [gymId, ...(lineIds.length > 0 ? lineIds : [opts.purchaseId])]);
      for (const r of rows) contents.products.push(String(r.name));
    }
  }
  return contents;
}

/** #3553: the contents name of a checkout, or null outside an Admin request or when it names nothing. */
export async function plannedContentsName(
  exec: Conn, gymId: string, opts: { productSetId?: number | null; purchaseId?: number | null; lineIds?: number[] },
): Promise<string | null> {
  if (currentRequestChannel() !== 'admin_app') return null;
  const contents = await loadPurchaseContents(exec, gymId, opts);
  const { rows } = await exec.query<{ name: string | null }>('SELECT name FROM gyms WHERE id = ?', [gymId]);
  return contentsPurchaseName({ gymName: rows[0]?.name, locale: currentRequestLocale(), contents });
}

/**
 * #3553 — an Admin Save & Pay names its cart after what it pays for, at the moment it leaves the cart:
 * only while the purchase is still `in_cart` (so a retry, a later status change or an edit after
 * payment never renames it), and before its checkout Billing Event copies the name (#3287).
 */
export async function nameCheckoutFromContents(
  tx: Conn, gymId: string, purchaseId: number | null | undefined,
  opts: { productSetId?: number | null; lineIds?: number[] } = {},
): Promise<void> {
  if (purchaseId == null) return;
  const name = await plannedContentsName(tx, gymId, { ...opts, purchaseId: opts.lineIds?.length ? null : purchaseId });
  if (name == null) return;
  await tx.query(
    "UPDATE purchases SET name = ? WHERE id = ? AND gym_id = ? AND status = 'in_cart'",
    [name, purchaseId, gymId]);
}

/** #3553: `nameCheckoutFromContents()` for the cart the Product Set `productSetId` belongs to. */
export async function nameSetCheckoutFromContents(tx: Conn, gymId: string, productSetId: number): Promise<void> {
  await nameCheckoutFromContents(tx, gymId, await purchaseOfSet(tx, gymId, productSetId), { productSetId });
}

/** #3288: a purchase's stored canonical name (null for none). */
export async function purchaseName(exec: Conn, gymId: string, purchaseId: number | null | undefined): Promise<string | null> {
  if (purchaseId == null) return null;
  const { rows } = await exec.query<{ name: string }>(
    'SELECT name FROM purchases WHERE id = ? AND gym_id = ?', [purchaseId, gymId]);
  return rows[0]?.name ?? null;
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

/** The carts the lines are in, and the one that holds nothing else (it is then the checkout itself). */
async function cartsOfLines(tx: Conn, gymId: string, lineIds: number[]): Promise<{ carts: Set<number>; sole: number | null }> {
  const carts = new Set<number>();
  for (const id of lineIds) for (const c of await purchasesOfLine(tx, gymId, id)) carts.add(c);
  const cartId = carts.size === 1 ? [...carts][0] : null;
  if (cartId != null && lineIds.length > 0) {
    const { rows } = await tx.query<{ n: number }>(
      `SELECT (SELECT COUNT(*) FROM product_sets WHERE gym_id = ? AND purchase_id = ?)
            + (SELECT COUNT(*) FROM product_session_snapshots WHERE gym_id = ? AND purchase_id = ? AND source_id NOT IN (${lineIds.map(() => '?').join(',')}))
            + (SELECT COUNT(*) FROM product_oneoff_snapshots WHERE gym_id = ? AND purchase_id = ? AND source_id NOT IN (${lineIds.map(() => '?').join(',')})) AS n`,
      [gymId, cartId, gymId, cartId, ...lineIds, gymId, cartId, ...lineIds]);
    if (Number(rows[0].n) === 0) return { carts, sole: cartId };
  }
  return { carts, sole: null };
}

/**
 * #3288 — the canonical name of the purchase a checkout of the one-time lines `lineIds` will charge,
 * known before the transaction so it can be the provider payment's `description`: the cart's own
 * name when the cart is the checkout, else a name planned for the new purchase, which the caller hands
 * to `splitOffCheckout()` / `insertPurchase()`. `lineIds` empty: a purchase of its own (a direct one).
 */
export async function planCheckoutPurchase(
  exec: Conn, gymId: string, lineIds: number[],
): Promise<{ name: string; planned?: PlannedPurchaseName }> {
  const { sole } = await cartsOfLines(exec, gymId, lineIds);
  // #3553: an Admin checkout is named after the lines it pays for; the cart itself takes the name in
  // the transaction (`nameCheckoutFromContents()`), a checkout split off it is created with it.
  const contentsName = lineIds.length > 0 ? await plannedContentsName(exec, gymId, { lineIds }) : null;
  const existing = sole != null ? await purchaseName(exec, gymId, sole) : null;
  if (existing != null) return { name: contentsName ?? existing };
  const planned = await planPurchaseName(exec, gymId);
  if (contentsName != null) planned.name = contentsName;
  return { name: planned.name, planned };
}

/**
 * #3288 — refuses a checkout whose purchase no longer carries the name already sent to the provider
 * (the cart changed between the plan and the transaction), so the payment's description, the
 * purchase and its Billing Event are always one string. The caller maps the throw to its 409.
 */
export async function checkoutNameStillHolds(
  tx: Conn, gymId: string, purchaseId: number, sentName: string,
): Promise<boolean> {
  return (await purchaseName(tx, gymId, purchaseId)) === sentName;
}

/**
 * A checkout of the one-time lines `lineIds` out of their cart: when the cart holds anything else
 * (the rest of the cart, or its Product Set), the lines move to a new purchase in `pending_payment`;
 * a cart that holds nothing else simply is the checkout. Answers the checkout's purchase.
 */
export async function splitOffCheckout(
  tx: Conn, gymId: string, ownerMemberId: number, lineIds: number[], actorName: string | null,
  /** #3288: the name (and instant) a new checkout purchase gets, when already sent to the provider. */
  planned?: PlannedPurchaseName,
): Promise<number> {
  const { carts, sole } = await cartsOfLines(tx, gymId, lineIds);
  if (sole != null) return sole;
  const checkout = await createPurchase(tx, gymId, ownerMemberId, 'pending_payment', actorName, planned);
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
  // #3274: entering the cart (opened, or back from a Pending Payment, #1991) starts a fresh clock;
  // leaving it stops the clock.
  await tx.query(
    // #3307 stage 2: entering `completed` stamps when the cart was paid (the Products view keeps it
    // visible for an hour after it); leaving it clears the stamp.
    `UPDATE purchases SET status = ?, expires_at = IF(? = 'in_cart', ${CART_EXPIRES_AT_SQL}, NULL),
            completed_at = IF(? = 'completed', UTC_TIMESTAMP(), NULL),
            modified_at = UTC_TIMESTAMP(), modified_by = ? WHERE id = ? AND status <> ?`,
    [status, status, status, SYSTEM_ACTOR, purchaseId, status]);
  // Staying in the cart: the change the caller made is the cart's activity.
  if (status === 'in_cart') {
    await tx.query(
      `UPDATE purchases SET expires_at = ${CART_EXPIRES_AT_SQL}
        WHERE id = ? AND status = 'in_cart' AND ${cartClockSql('purchases')} > UTC_TIMESTAMP()`, [purchaseId]);
  }
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
      // #3251 stage 2: what the newer cart wrote (plan snapshots, recurring lines) moves with it.
      for (const table of STAMPED_TABLES) {
        await tx.query(`UPDATE ${table} SET purchase_id = ? WHERE gym_id = ? AND purchase_id = ?`, [purchaseId, gymId, otherId]);
      }
      // #3284 stage 2: and so do its staff Initial Payment waivers (a key both carts waived stays once).
      await tx.query('UPDATE IGNORE initial_payment_waivers SET purchase_id = ? WHERE gym_id = ? AND purchase_id = ?',
        [purchaseId, gymId, otherId]);
      await tx.query('DELETE FROM purchases WHERE id = ?', [otherId]);
    }
  }
  await writeStatus(tx, purchaseId, status);
}

/**
 * #3251 stage 2 — the cart a plan snapshot or a recurring line was written in (`purchase_id`, migration 467).
 *
 * Called right after the INSERT of the snapshot `snapshotId` for the Product Set `productSetId`:
 *   - a new snapshot takes the set's cart (none for a version that is not a checkout: a bridge edit, a
 *     reprice, a system run);
 *   - a copy (`copiedFromId`) made for a set that is in the cart or awaiting its payment is that cart's
 *     change, so it takes that cart; any other copy (a lifecycle copy onto an Active set, a bridge edit's
 *     copy) continues the checkout that created its source and keeps the source's purchase — never a
 *     fabricated one (#3251's price-change clarification).
 * A snapshot linked unchanged by a later set is not written, so it keeps its original purchase.
 */
export async function stampSnapshotPurchase(
  tx: Conn, gymId: string, table: 'plan_snapshots' | 'product_periodical_snapshots',
  snapshotId: number, productSetId: number, copiedFromId: number | null = null,
): Promise<void> {
  if (copiedFromId == null) {
    await tx.query(
      `UPDATE ${table} s JOIN product_sets ps ON ps.id = ? AND ps.gym_id = s.gym_id
          SET s.purchase_id = ps.purchase_id
        WHERE s.id = ? AND s.gym_id = ?`,
      [productSetId, snapshotId, gymId]);
    return;
  }
  await tx.query(
    `UPDATE ${table} s
       JOIN product_sets ps ON ps.id = ? AND ps.gym_id = s.gym_id
       LEFT JOIN ${table} src ON src.id = ? AND src.gym_id = s.gym_id
        SET s.purchase_id = IF(ps.purchase_id IS NOT NULL AND ps.status IN ('in_cart','pending_payment'),
                               ps.purchase_id, src.purchase_id)
      WHERE s.id = ? AND s.gym_id = ?`,
    [productSetId, copiedFromId, snapshotId, gymId]);
}

/**
 * #3251 stage 2 — a checkout's Billing Event is the cart's (`billing_events.purchase_id`).
 * #3287 — and carries the purchase's canonical name, copied verbatim into `billing_events.name` in the
 * same statement, so the event keeps that identity whatever later happens to the purchase row. The
 * #2940 name it was inserted with is replaced only here, for an event a purchase owns.
 * `keepExisting`: an event that already names a purchase keeps it, and its name (a one-time line
 * joining a Product Set's initial event).
 */
export async function stampEventPurchase(
  tx: Conn, gymId: string, billingEventId: number, purchaseId: number | null,
  opts: { keepExisting?: boolean } = {},
): Promise<void> {
  if (purchaseId == null) return;
  await tx.query(
    `UPDATE billing_events be JOIN purchases p ON p.id = ? AND p.gym_id = be.gym_id
        SET be.name = p.name, be.purchase_id = p.id
      WHERE be.id = ? AND be.gym_id = ?${opts.keepExisting ? ' AND be.purchase_id IS NULL' : ''}`,
    [purchaseId, billingEventId, gymId]);
}

/**
 * #3288 — the provider description of a new attempt on the Billing Event `billingEventId`: the
 * purchase name the event carries (#3287) when a purchase owns it, so a retry of a checkout sends
 * the same string as its first attempt; else `fallback`.
 */
export async function paymentDescriptionForEvent(
  exec: Conn, gymId: string, billingEventId: number | null | undefined, fallback: string,
): Promise<string> {
  if (billingEventId == null) return fallback;
  const { rows } = await exec.query<{ name: string | null }>(
    'SELECT name FROM billing_events WHERE id = ? AND gym_id = ? AND purchase_id IS NOT NULL', [billingEventId, gymId]);
  return rows[0]?.name || fallback;
}
