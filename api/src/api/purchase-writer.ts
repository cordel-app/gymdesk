/**
 * #2126 stage 5b — the one writer of a bought one-time Product.
 *
 * Until stage 5a a purchase was written to the legacy record (`member_products_oneoff_snapshot`,
 * its Promotions in `member_products_oneoff_promotion_snapshot`) and the Product snapshot tables
 * were then **re-derived from that record** by `syncProductSnapshotForPurchase()`. Every reader
 * already reads the snapshot tables (stage 3), so this module inverts the direction: each write
 * is made **from the writer's own values** into the snapshot (`product_session_snapshots` for a
 * Sessions package, `product_oneoff_snapshots` for anything else, `product_promotion_snapshots`
 * and the Billing Event junction) and, in the same transaction, into the legacy record, which is
 * still written only because it allocates the purchase id (`source_id`, what the routes and
 * Promotion snapshots are keyed on) and carries the pending-purchase UNIQUE key. Nothing here
 * reads a legacy table, so stage 5d drops the legacy halves of these functions and nothing else.
 *
 * The two halves are written with the same values, timestamps included (one `now` per write), so
 * `npm run product-snapshots:validate` can compare them field by field.
 */
import type { Tx } from '../infra/db';
import { PURCHASE_EVENT_JUNCTIONS } from './snapshot-junction-sync';

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
}

/** Writes a purchase (record + snapshot + event link) and returns the purchase id. */
export async function insertPurchase(tx: Conn, v: PurchaseValues): Promise<number> {
  const now = new Date();
  const { insertId: purchaseId } = await tx.query(
    `INSERT INTO member_products_oneoff_snapshot
       (gym_id, member_id, product_id, status, product_name, product_type, billing_frequency, units,
        amount, currency, tax_rate_percent, payment_request_id, created_at, created_by,
        list_price, direct_discount_percent, direct_discount_amount, validity_days, origin, assigned_member_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      v.gymId, v.memberId, v.productId, v.status, v.productName, v.productType, v.billingFrequency, v.units,
      money(v.amount), v.currency, v.taxRatePercent, v.paymentRequestId, now, v.createdBy,
      money(v.listPrice), money(v.directDiscountPercent), money(v.directDiscountAmount), v.validityDays,
      v.origin, v.assignedMemberId,
    ],
  );
  const table = purchaseSnapshotTable(v.productType);
  const { insertId: snapshotId } = await tx.query(
    `INSERT INTO ${table}
       (gym_id, member_id, product_set_id, product_id, source_id, status, is_inherited, product_name, product_type,
        billing_frequency, units, quantity, currency, unit_price, list_price, direct_discount_percent,
        direct_discount_amount, tax_rate_percent, origin, member_product_id, validity_days,
        created_at, created_by, assigned_member_id)
     VALUES (?, ?, NULL, ?, ?, ?, 0, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      v.gymId, v.memberId, v.productId, purchaseId, v.status, v.productName, v.productType,
      v.billingFrequency, v.units, v.currency, money(v.amount), money(v.listPrice), money(v.directDiscountPercent),
      money(v.directDiscountAmount), v.taxRatePercent, v.origin, purchaseId, v.validityDays,
      now, v.createdBy, v.assignedMemberId,
    ],
  );
  if (v.billingEventId != null) {
    const j = PURCHASE_EVENT_JUNCTIONS.find((x) => x.table === table)!;
    await tx.query(
      `INSERT IGNORE INTO ${j.junction} (billing_event_id, ${j.snapshotCol}) VALUES (?, ?)`,
      [v.billingEventId, snapshotId],
    );
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
 * in the same transaction (the record's row and the snapshot's row, the latter under its purchase
 * snapshot, keyed back to the record's row by `source_purchase_promotion_id`).
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
  const { insertId } = await tx.query(
    `INSERT INTO member_products_oneoff_promotion_snapshot
       (gym_id, member_product_id, promotion_id, promotion_name,
        benefit_action, benefit_value, duration_cycles, regular_amount, final_amount, applied_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [gymId, purchaseId, ...values],
  );
  const table = purchaseSnapshotTable(productType);
  const { rowCount } = await tx.query(
    `INSERT INTO product_promotion_snapshots
       (gym_id, member_id, ${parentColumn(table)}, source_purchase_promotion_id, promotion_id, promotion_name, status,
        benefit_action, benefit_value, duration_cycles, regular_amount, final_amount, applied_at, created_at)
     SELECT s.gym_id, s.member_id, s.id, ?, ?, ?, 'applied', ?, ?, ?, ?, ?, ?, ?
       FROM ${table} s WHERE s.gym_id = ? AND s.source_id = ?`,
    [insertId, ...values, now, gymId, purchaseId],
  );
  if (rowCount !== 1) throw new Error(`Purchase ${purchaseId} has no snapshot to freeze its Promotion onto`);
}

/**
 * Hard-deletes a purchase (only a staff draft is ever deleted, #1657): its Promotions, its record and
 * its snapshot, whose Promotion snapshots and junction rows cascade with it.
 */
export async function deletePurchase(tx: Conn, gymId: string, purchaseId: number, where: { memberId: number; status: string }): Promise<boolean> {
  await tx.query(
    'DELETE FROM member_products_oneoff_promotion_snapshot WHERE gym_id = ? AND member_product_id = ?',
    [gymId, purchaseId],
  );
  const { rowCount } = await tx.query(
    'DELETE FROM member_products_oneoff_snapshot WHERE id = ? AND gym_id = ? AND member_id = ? AND status = ?',
    [purchaseId, gymId, where.memberId, where.status],
  );
  for (const table of SNAPSHOT_TABLES) {
    await tx.query(
      `DELETE FROM ${table} WHERE gym_id = ? AND source_id = ? AND member_id = ? AND status = ?`,
      [gymId, purchaseId, where.memberId, where.status],
    );
  }
  return rowCount > 0;
}

/** The columns a purchase's lifecycle moves (the rest is frozen at purchase time). */
export interface PurchaseChange {
  status?: string;
  purchasedAt?: Date;
  validUntil?: string | null;
  cancelledOn?: string;
}

/**
 * Moves a purchase's lifecycle columns on the record and the snapshot alike, guarded by the status
 * it must still hold (`fromStatus`) or by the cancellation not having happened (`whenNotCancelled`),
 * so a duplicate webhook or a repeat cancel changes neither. Answers the rows changed on the record.
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

  const { rowCount } = await tx.query(
    `UPDATE member_products_oneoff_snapshot SET ${assignments}, modified_by = ? WHERE id = ? AND gym_id = ? AND ${guardSql}`,
    [...params, purchaseId, gymId, ...guardParams],
  );
  if (rowCount > 0) {
    for (const table of SNAPSHOT_TABLES) {
      await tx.query(
        `UPDATE ${table} SET ${assignments}, modified_by = ? WHERE source_id = ? AND gym_id = ? AND ${guardSql}`,
        [...params, purchaseId, gymId, ...guardParams],
      );
    }
  }
  return rowCount;
}

/**
 * Locks a member's purchase before one of the writers above moves it (a repeat cancel waits here).
 * The snapshot row is locked, not the record: every writer writes the snapshot, so it serialises
 * them exactly as the record's lock did, and it is the row that survives stage 5d.
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
