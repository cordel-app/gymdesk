/**
 * #2126 stage 5b — test fixture only. Production writers write a purchase's Product snapshot from
 * their own values (`api/purchase-writer.ts`); a test that inserts a legacy
 * `member_products_oneoff_snapshot` row by hand calls these to give it the snapshot (and the
 * Billing Event link) a real writer would have written. They read the legacy tables, which is
 * why they live here and not under `api/` (`product-snapshot-legacy-readers.unit.test.ts`).
 */
import type { Tx } from '../infra/db';
import { PURCHASE_EVENT_JUNCTIONS } from '../api/snapshot-junction-sync';

type Conn = Pick<Tx, 'query'>;

/** Links a bought one-time Product's snapshot to the Billing Event of its payment request. */
export async function linkPurchaseToBillingEvent(tx: Conn, gymId: string, purchaseId: number): Promise<void> {
  for (const j of PURCHASE_EVENT_JUNCTIONS) {
    await tx.query(
      `INSERT IGNORE INTO ${j.junction} (billing_event_id, ${j.snapshotCol})
       SELECT pr.billing_event_id, s.id
         FROM member_products_oneoff_snapshot mp
         JOIN payment_requests pr ON pr.id = mp.payment_request_id AND pr.gym_id = mp.gym_id
         JOIN ${j.table} s ON s.source_id = mp.id AND s.gym_id = mp.gym_id
        WHERE mp.id = ? AND mp.gym_id = ? AND pr.billing_event_id IS NOT NULL`,
      [purchaseId, gymId]);
  }
}

const PURCHASE_TABLES = ['product_session_snapshots', 'product_oneoff_snapshots'] as const;

/** Re-derives the snapshot of one bought one-time Product (and the Promotions frozen onto it). */
export async function syncProductSnapshotForPurchase(tx: Conn, gymId: string, purchaseId: number): Promise<void> {
  const { rows } = await tx.query<{ product_type: string | null }>(
    'SELECT product_type FROM member_products_oneoff_snapshot WHERE id = ? AND gym_id = ?', [purchaseId, gymId]);
  if (!rows[0]) {
    // The purchase is gone (a draft discarded or promoted): its snapshots go with it.
    for (const table of PURCHASE_TABLES) {
      await tx.query(`DELETE FROM ${table} WHERE gym_id = ? AND source_id = ?`, [gymId, purchaseId]);
    }
    return;
  }

  const isSessions = rows[0].product_type === 'sessions';
  const target = isSessions ? 'product_session_snapshots' : 'product_oneoff_snapshots';
  const other = isSessions ? 'product_oneoff_snapshots' : 'product_session_snapshots';
  const parentCol = isSessions ? 'product_session_snapshot_id' : 'product_oneoff_snapshot_id';
  await tx.query(`DELETE FROM ${other} WHERE gym_id = ? AND source_id = ?`, [gymId, purchaseId]);

  await tx.query(
    `INSERT INTO ${target}
       (gym_id, member_id, product_set_id, product_id, source_id, status, is_inherited, product_name, product_type,
        billing_frequency, units, quantity, currency, unit_price, list_price, direct_discount_percent,
        direct_discount_amount, tax_rate_percent, origin, member_product_id, purchased_at, validity_days,
        valid_until, cancelled_on, created_at, created_by, modified_at, modified_by, assigned_member_id)
     SELECT mp.gym_id, mp.member_id, NULL, mp.product_id, mp.id, mp.status, 0, mp.product_name, mp.product_type,
            mp.billing_frequency, mp.units, 1, mp.currency, mp.amount, mp.list_price, mp.direct_discount_percent,
            mp.direct_discount_amount, mp.tax_rate_percent, mp.origin, mp.id, mp.purchased_at, mp.validity_days,
            mp.valid_until, mp.cancelled_on, mp.created_at, mp.created_by, mp.modified_at, mp.modified_by, mp.assigned_member_id
       FROM member_products_oneoff_snapshot mp
      WHERE mp.id = ? AND mp.gym_id = ?
     ON DUPLICATE KEY UPDATE
       product_id = VALUES(product_id), status = VALUES(status), product_name = VALUES(product_name),
       product_type = VALUES(product_type), billing_frequency = VALUES(billing_frequency), units = VALUES(units),
       currency = VALUES(currency), unit_price = VALUES(unit_price), list_price = VALUES(list_price),
       direct_discount_percent = VALUES(direct_discount_percent),
       direct_discount_amount = VALUES(direct_discount_amount), tax_rate_percent = VALUES(tax_rate_percent),
       origin = VALUES(origin), purchased_at = VALUES(purchased_at), validity_days = VALUES(validity_days),
       valid_until = VALUES(valid_until), cancelled_on = VALUES(cancelled_on),
       assigned_member_id = VALUES(assigned_member_id),
       modified_at = VALUES(modified_at), modified_by = VALUES(modified_by)`,
    [purchaseId, gymId]);

  // Promotions frozen onto the purchase are written once and never edited: stale ones go, new ones come.
  await tx.query(
    `DELETE pp FROM product_promotion_snapshots pp
       JOIN ${target} par ON par.id = pp.${parentCol}
      WHERE par.gym_id = ? AND par.source_id = ?
        AND (pp.source_purchase_promotion_id IS NULL OR pp.source_purchase_promotion_id NOT IN
              (SELECT x.id FROM member_products_oneoff_promotion_snapshot x
                WHERE x.gym_id = ? AND x.member_product_id = ?))`,
    [gymId, purchaseId, gymId, purchaseId]);
  await tx.query(
    `INSERT INTO product_promotion_snapshots
       (gym_id, member_id, ${parentCol}, source_purchase_promotion_id, promotion_id, promotion_name, status,
        benefit_action, benefit_value, duration_cycles, regular_amount, final_amount, applied_at, created_at)
     SELECT pp.gym_id, par.member_id, par.id, pp.id, pp.promotion_id, pp.promotion_name, 'applied',
            pp.benefit_action, pp.benefit_value, pp.duration_cycles, pp.regular_amount, pp.final_amount,
            pp.applied_at, pp.applied_at
       FROM member_products_oneoff_promotion_snapshot pp
       JOIN ${target} par ON par.source_id = pp.member_product_id AND par.gym_id = pp.gym_id
      WHERE pp.gym_id = ? AND pp.member_product_id = ?
        AND NOT EXISTS (SELECT 1 FROM product_promotion_snapshots x WHERE x.source_purchase_promotion_id = pp.id)`,
    [gymId, purchaseId]);
  await linkPurchaseToBillingEvent(tx, gymId, purchaseId);
}

/** The purchase a payment request belongs to, if any (the webhook and cleanup know the request, not the purchase). */
export async function syncProductSnapshotForPaymentRequest(tx: Conn, gymId: string, paymentRequestId: number): Promise<void> {
  const { rows } = await tx.query<{ id: number }>(
    'SELECT id FROM member_products_oneoff_snapshot WHERE gym_id = ? AND payment_request_id = ?', [gymId, paymentRequestId]);
  for (const r of rows) await syncProductSnapshotForPurchase(tx, gymId, Number(r.id));
}
