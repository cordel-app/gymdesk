/**
 * #2126 stage 5b — the one writer of a bought one-time Product.
 *
 * A purchase is its Product snapshot: `product_session_snapshots` for a Sessions package,
 * `product_oneoff_snapshots` for anything else, its Promotions in `product_promotion_snapshots`, and
 * its payment reached through the Billing Event junction. Stage 5b made every write go from the
 * writer's own values into those tables (and, beside them, into the legacy record); since stage 5d-5
 * the legacy record (`member_products_oneoff_snapshot`, `member_products_oneoff_promotion_snapshot`)
 * is no longer written at all, and since stage 5d-6 (migration 415) both tables are dropped.
 *
 * The purchase id (`source_id`, what the routes and Promotion snapshots are keyed on) comes from
 * `product_line_ids` (`allocateLineId()`, `product_purchase_ids` until #3251): a purchase's snapshot
 * lives in one of two tables, each with its own sequence, so neither can allocate an id unique across
 * both. A Promotion frozen onto a purchase takes its id from its own snapshot row since stage 5d-4.
 *
 * #3251: that id identifies one line. The cart it was bought in is `purchase_id` (`purchases`,
 * `api/purchases.ts`): a line written `in_cart` joins the owner's open cart, any other starts a
 * checkout of its own, and every write here marks the cart for its status to follow.
 */
import type { Tx } from '../infra/db';
import { PURCHASE_EVENT_JUNCTIONS } from './snapshot-junction-sync';
import { createPurchase, openCart, purchasesOfLine, touchPurchases } from './purchases';
import { CART_ITEM_STATUS } from '../domain/purchaseStatus';

type Conn = Pick<Tx, 'query'>;

/** The snapshot table a bought Product is frozen in: a Sessions package keeps its own type (#2126 stage 5a, option A). */
export function purchaseSnapshotTable(productType: string | null): 'product_session_snapshots' | 'product_oneoff_snapshots' {
  return productType === 'sessions' ? 'product_session_snapshots' : 'product_oneoff_snapshots';
}

const SNAPSHOT_TABLES = ['product_session_snapshots', 'product_oneoff_snapshots'] as const;

function parentColumn(table: string): string {
  return table === 'product_session_snapshots' ? 'product_session_snapshot_id' : 'product_oneoff_snapshot_id';
}

const money = (n: number | null | undefined): string | null => (n == null ? null : n.toFixed(2));

export interface PurchaseValues {
  gymId: string;
  memberId: number;
  productId: number;
  status: string;
  productName: string;
  productType: string | null;
  billingFrequency: string | null;
  units: number | null;
  /** What is charged, VAT-inclusive (the record's `amount`, the snapshot's `unit_price`). */
  amount: number;
  /** The price of one unit; defaults to `amount` (quantity 1). `amount` is the total, `unitAmount` x `quantity`. */
  unitAmount?: number;
  quantity?: number;
  currency: string;
  taxRatePercent: number | null;
  listPrice: number | null;
  directDiscountPercent: number | null;
  directDiscountAmount: number | null;
  validityDays: number | null;
  origin: string | null;
  assignedMemberId: number | null;
  createdBy: string | null;
  /** The purchase's payment request and its Billing Event; both NULL for a staff draft. */
  paymentRequestId: number | null;
  billingEventId: number | null;
  /** #3251: the cart the line belongs to; by default the owner's open cart (`in_cart`) or a new checkout. */
  cartId?: number | null;
}

/**
 * #2126 stage 5d-3 — hands out a new one-time line id. One row per id in `product_line_ids`
 * (`product_purchase_ids` until #3251), whose primary key is what makes a line id unique across
 * `product_session_snapshots` and `product_oneoff_snapshots`. In the caller's transaction, so a
 * rolled-back purchase registers nothing (InnoDB does not hand the id out again either).
 */
export async function allocateLineId(tx: Conn, gymId: string): Promise<number> {
  const { insertId } = await tx.query('INSERT INTO product_line_ids (gym_id) VALUES (?)', [gymId]);
  const id = Number(insertId);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Purchase id allocation returned no id');
  return id;
}

/** Writes a purchase (snapshot + event link) and returns the purchase id. */
export async function insertPurchase(tx: Conn, v: PurchaseValues): Promise<number> {
  const now = new Date();
  const purchaseId = await allocateLineId(tx, v.gymId);
  const cartId = v.cartId ?? (v.status === 'in_cart'
    ? await openCart(tx, v.gymId, v.memberId, v.createdBy)
    : await createPurchase(tx, v.gymId, v.memberId, CART_ITEM_STATUS.line(v.status) ?? 'pending_payment', v.createdBy));
  const table = purchaseSnapshotTable(v.productType);
  const { insertId: snapshotId } = await tx.query(
    `INSERT INTO ${table}
       (gym_id, member_id, product_id, source_id, status, product_name, product_type,
        billing_frequency, units, quantity, currency, unit_price, list_price, direct_discount_percent,
        direct_discount_amount, tax_rate_percent, origin, member_product_id, validity_days,
        created_at, created_by, assigned_member_id, purchase_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      v.gymId, v.memberId, v.productId, purchaseId, v.status, v.productName, v.productType,
      v.billingFrequency, v.units, v.quantity ?? 1, v.currency, money(v.unitAmount ?? v.amount), money(v.listPrice), money(v.directDiscountPercent),
      money(v.directDiscountAmount), v.taxRatePercent, v.origin, purchaseId, v.validityDays,
      now, v.createdBy, v.assignedMemberId, cartId,
    ],
  );
  await touchPurchases(tx, v.gymId, [cartId]);
  if (v.billingEventId != null) {
    const j = PURCHASE_EVENT_JUNCTIONS.find((x) => x.table === table)!;
    await tx.query(
      `INSERT IGNORE INTO ${j.junction} (billing_event_id, ${j.snapshotCol}) VALUES (?, ?)`,
      [v.billingEventId, snapshotId],
    );
    // #3251 stage 2: the purchase's own Billing Event is its checkout's (an event that already names
    // a cart, a Product Set's initial event, keeps it).
    await tx.query('UPDATE billing_events SET purchase_id = COALESCE(purchase_id, ?) WHERE id = ? AND gym_id = ?',
      [cartId, v.billingEventId, v.gymId]);
  }
  return purchaseId;
}

export interface PurchasePromotionStep {
  promotion_id: number;
  promotion_name: string;
  action: string;
  value: number | null;
  duration_cycles: number | null;
  regular_amount: number;
  final_amount: number;
}

/**
 * #1118 §7 / #1521 — freezes one applied Promotion onto a purchase written by `insertPurchase()`
 * in the same transaction, under its purchase snapshot.
 *
 * Since #2126 stage 5d-4 the Promotion's id comes from its snapshot: the `product_promotion_snapshots`
 * row is inserted first and its own id becomes `source_purchase_promotion_id` (what the purchase reads
 * report the application under). Migration 414 put the snapshot's sequence above every historical id.
 */
export async function insertPurchasePromotion(
  tx: Conn,
  gymId: string,
  purchaseId: number,
  productType: string | null,
  step: PurchasePromotionStep,
): Promise<void> {
  const now = new Date();
  const values = [
    step.promotion_id, step.promotion_name, step.action, money(step.value), step.duration_cycles,
    money(step.regular_amount), money(step.final_amount), now,
  ];
  const table = purchaseSnapshotTable(productType);
  const { insertId } = await tx.query(
    `INSERT INTO product_promotion_snapshots
       (gym_id, member_id, ${parentColumn(table)}, promotion_id, promotion_name, status,
        benefit_action, benefit_value, duration_cycles, regular_amount, final_amount, applied_at, created_at,
        promotion_image_url, promotion_image_thumbnail_url)
     SELECT s.gym_id, s.member_id, s.id, ?, ?, 'applied', ?, ?, ?, ?, ?, ?, ?,
            (SELECT image_url FROM promotions WHERE id = ? AND gym_id = s.gym_id),
            (SELECT image_thumbnail_url FROM promotions WHERE id = ? AND gym_id = s.gym_id)
       FROM ${table} s WHERE s.gym_id = ? AND s.source_id = ?`,
    [...values, now, step.promotion_id, step.promotion_id, gymId, purchaseId],
  );
  if (!insertId) throw new Error(`Purchase ${purchaseId} has no snapshot to freeze its Promotion onto`);
  const promotionId = Number(insertId);
  await tx.query(
    'UPDATE product_promotion_snapshots SET source_purchase_promotion_id = id WHERE id = ?', [promotionId]);
}

/**
 * Hard-deletes a purchase (only a staff draft is ever deleted, #1657): its snapshot, whose
 * Promotion snapshots and junction rows cascade with it.
 */
export async function deletePurchase(tx: Conn, gymId: string, purchaseId: number, where: { memberId: number; status: string }): Promise<boolean> {
  // #3251: the cart the line leaves; emptied and unconfirmed, it goes too (`syncPurchase()`).
  await touchPurchases(tx, gymId, await purchasesOfLine(tx, gymId, purchaseId));
  let deleted = 0;
  for (const table of SNAPSHOT_TABLES) {
    const { rowCount } = await tx.query(
      `DELETE FROM ${table} WHERE gym_id = ? AND source_id = ? AND member_id = ? AND status = ?`,
      [gymId, purchaseId, where.memberId, where.status],
    );
    deleted += rowCount;
  }
  return deleted > 0;
}

/** The columns a purchase's lifecycle moves (the rest is frozen at purchase time). */
export interface PurchaseChange {
  status?: string;
  purchasedAt?: Date;
  validUntil?: string | null;
  cancelledOn?: string;
}

/**
 * Moves a purchase's lifecycle columns on its snapshot, guarded by the status
 * it must still hold (`fromStatus`) or by the cancellation not having happened (`whenNotCancelled`),
 * so a duplicate webhook or a repeat cancel changes neither. Answers the rows changed.
 */
export async function updatePurchase(
  tx: Conn,
  gymId: string,
  purchaseId: number,
  change: PurchaseChange,
  modifiedBy: string,
  guard: { fromStatus: string } | { whenNotCancelled: true },
): Promise<number> {
  const sets: string[] = [];
  const params: Array<string | number | Date | null> = [];
  if (change.status !== undefined) { sets.push('status = ?'); params.push(change.status); }
  if (change.purchasedAt !== undefined) { sets.push('purchased_at = ?'); params.push(change.purchasedAt); }
  if (change.validUntil !== undefined) { sets.push('valid_until = ?'); params.push(change.validUntil); }
  if (change.cancelledOn !== undefined) { sets.push('cancelled_on = ?'); params.push(change.cancelledOn); }
  const assignments = [...sets, 'modified_at = ?'].join(', ');
  params.push(new Date(), modifiedBy);
  const guardSql = 'fromStatus' in guard ? 'status = ?' : 'cancelled_on IS NULL';
  const guardParams = 'fromStatus' in guard ? [guard.fromStatus] : [];

  if (change.status !== undefined) await touchPurchases(tx, gymId, await purchasesOfLine(tx, gymId, purchaseId));
  let changed = 0;
  for (const table of SNAPSHOT_TABLES) {
    const { rowCount } = await tx.query(
      `UPDATE ${table} SET ${assignments}, modified_by = ? WHERE source_id = ? AND gym_id = ? AND ${guardSql}`,
      [...params, purchaseId, gymId, ...guardParams],
    );
    changed += rowCount;
  }
  return changed;
}

/**
 * Locks a member's purchase before one of the writers above moves it (a repeat cancel waits here).
 * The snapshot row is locked: it is the row every writer writes.
 */
export async function lockPurchase(tx: Conn, gymId: string, memberId: number, purchaseId: number): Promise<boolean> {
  for (const table of SNAPSHOT_TABLES) {
    const { rows } = await tx.query<{ id: number }>(
      `SELECT id FROM ${table} WHERE source_id = ? AND gym_id = ? AND member_id = ? FOR UPDATE`,
      [purchaseId, gymId, memberId],
    );
    if (rows[0]) return true;
  }
  return false;
}
