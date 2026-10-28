/**
 * #2126 stage 2 — dual-write of the Product snapshot model (migration 348) beside the legacy
 * rows. Nothing reads these tables yet (stage 3): this module only keeps them equal to what the
 * legacy tables say, in the very transaction that changed the legacy rows.
 *
 * Two idempotent re-derivations, both keyed by the `source_*` columns stage 1 added so the
 * backfill and the dual-write can never disagree about which row is whose:
 *   - `syncProductSnapshotsOfVersion()` — the recurring lines of one ProductSet version
 *     (`member_products_recurrent_snapshot`), the Product-target applications owned by a line and
 *     the Products each froze. Copying a version (`cloneConfiguration()`) copies them by
 *     re-deriving, `is_inherited` included, and creates no purchase, application or charge.
 *   - `syncProductSnapshotForPurchase()` — one bought one-time Product
 *     (`member_products_oneoff_snapshot`, which stays the purchase and financial record) and the
 *     Promotions frozen onto it.
 */
import type { Tx } from '../infra/db';

type Conn = Pick<Tx, 'query'>;

const GRANT_SOURCES: Array<{ kind: string; source: string }> = [
  { kind: 'session', source: 'user_membership_promotion_session_snapshot' },
  { kind: 'oneoff', source: 'user_membership_promotion_oneoff_snapshot' },
  { kind: 'periodical', source: 'user_membership_promotion_periodical_snapshot' },
];

/** Re-derives the recurring Product snapshots of one ProductSet version from its legacy rows. */
export async function syncProductSnapshotsOfVersion(tx: Conn, gymId: string, productSetId: number): Promise<void> {
  // A line that no longer exists takes its snapshot, promotions and grants with it (cascade).
  await tx.query(
    `DELETE FROM product_periodical_snapshots
      WHERE gym_id = ? AND product_set_id = ?
        AND (source_id IS NULL OR source_id NOT IN
              (SELECT id FROM member_products_recurrent_snapshot WHERE gym_id = ? AND product_set_id = ?))`,
    [gymId, productSetId, gymId, productSetId]);

  await tx.query(
    `INSERT INTO product_periodical_snapshots
       (gym_id, member_id, product_set_id, product_id, source_id, status, is_inherited, product_name, product_type,
        billing_frequency, quantity, currency, unit_price, list_price, direct_discount_percent, starts_at, ends_at,
        origin, schedule_id, line_ref, created_at)
     SELECT s.gym_id, ps.owner_member_id, s.product_set_id, s.product_id, s.id, ps.status, s.is_inherited,
            COALESCE(s.item_name, p.name), COALESCE(s.item_type, p.type), s.item_billing_frequency, s.quantity,
            s.currency, s.unit_price, s.list_unit_price, s.direct_discount_percent, s.starts_at, s.ends_at,
            s.origin, s.schedule_id, s.line_ref, s.created_at
       FROM member_products_recurrent_snapshot s
       JOIN product_sets ps ON ps.id = s.product_set_id AND ps.gym_id = s.gym_id
       JOIN products p ON p.id = s.product_id
      WHERE s.gym_id = ? AND s.product_set_id = ?
     ON DUPLICATE KEY UPDATE
       member_id = VALUES(member_id), product_id = VALUES(product_id), status = VALUES(status),
       is_inherited = VALUES(is_inherited), product_name = VALUES(product_name), product_type = VALUES(product_type),
       billing_frequency = VALUES(billing_frequency), quantity = VALUES(quantity), currency = VALUES(currency),
       unit_price = VALUES(unit_price), list_price = VALUES(list_price),
       direct_discount_percent = VALUES(direct_discount_percent), starts_at = VALUES(starts_at),
       ends_at = VALUES(ends_at), origin = VALUES(origin), schedule_id = VALUES(schedule_id),
       line_ref = VALUES(line_ref), modified_at = UTC_TIMESTAMP()`,
    [gymId, productSetId]);

  // Product-target applications owned by a line of this version.
  const owned = `SELECT ump.id FROM user_membership_promotions ump
                   JOIN promotions pr ON pr.id = ump.promotion_id AND pr.applies_to = 'product'
                  WHERE ump.gym_id = ? AND ump.product_set_id = ? AND ump.recurrent_snapshot_id IS NOT NULL`;
  await tx.query(
    `DELETE pp FROM product_promotion_snapshots pp
       JOIN product_periodical_snapshots par ON par.id = pp.product_periodical_snapshot_id
      WHERE par.gym_id = ? AND par.product_set_id = ?
        AND (pp.source_application_id IS NULL OR pp.source_application_id NOT IN (${owned}))`,
    [gymId, productSetId, gymId, productSetId]);
  await tx.query(
    `INSERT INTO product_promotion_snapshots
       (gym_id, member_id, product_periodical_snapshot_id, source_application_id, promotion_id, promotion_name,
        status, is_inherited, snapshot, applied_at, applied_by, consumed_at, revoked_at, created_at, created_by,
        modified_at, modified_by)
     SELECT ump.gym_id, par.member_id, par.id, ump.id, ump.promotion_id,
            JSON_UNQUOTE(JSON_EXTRACT(ump.snapshot, '$.name')), ump.status, 0, ump.snapshot, ump.applied_at,
            ump.applied_by, ump.consumed_at, ump.revoked_at, ump.applied_at, ump.created_by, ump.modified_at,
            ump.modified_by
       FROM user_membership_promotions ump
       JOIN promotions pr ON pr.id = ump.promotion_id AND pr.applies_to = 'product'
       JOIN product_periodical_snapshots par ON par.source_id = ump.recurrent_snapshot_id AND par.gym_id = ump.gym_id
      WHERE ump.gym_id = ? AND ump.product_set_id = ? AND ump.recurrent_snapshot_id IS NOT NULL
     ON DUPLICATE KEY UPDATE
       member_id = VALUES(member_id), status = VALUES(status), snapshot = VALUES(snapshot),
       consumed_at = VALUES(consumed_at), revoked_at = VALUES(revoked_at),
       modified_at = VALUES(modified_at), modified_by = VALUES(modified_by)`,
    [gymId, productSetId]);

  for (const { kind, source } of GRANT_SOURCES) {
    await tx.query(
      `DELETE g FROM product_promotion_grant_snapshots g
         JOIN product_promotion_snapshots pp ON pp.id = g.product_promotion_snapshot_id
         JOIN product_periodical_snapshots par ON par.id = pp.product_periodical_snapshot_id
        WHERE g.grant_kind = '${kind}' AND par.gym_id = ? AND par.product_set_id = ?
          AND (g.source_id IS NULL OR g.source_id NOT IN
                (SELECT x.id FROM ${source} x WHERE x.gym_id = ? AND x.user_membership_promotion_id = pp.source_application_id))`,
      [gymId, productSetId, gymId]);
    await tx.query(
      `INSERT INTO product_promotion_grant_snapshots
         (gym_id, product_promotion_snapshot_id, grant_kind, source_id, product_id, product_name, quantity,
          item_type, item_billing_frequency, unit_price, currency, action, value, requirement, created_at)
       SELECT g.gym_id, pp.id, '${kind}', g.id, g.product_id, g.product_name, g.quantity, g.item_type,
              g.item_billing_frequency, g.unit_price, g.currency, g.action, g.value, g.requirement, g.created_at
         FROM ${source} g
         JOIN product_promotion_snapshots pp
           ON pp.source_application_id = g.user_membership_promotion_id AND pp.gym_id = g.gym_id
         JOIN product_periodical_snapshots par ON par.id = pp.product_periodical_snapshot_id
        WHERE par.gym_id = ? AND par.product_set_id = ?
       ON DUPLICATE KEY UPDATE
         product_id = VALUES(product_id), product_name = VALUES(product_name), quantity = VALUES(quantity),
         item_type = VALUES(item_type), item_billing_frequency = VALUES(item_billing_frequency),
         unit_price = VALUES(unit_price), currency = VALUES(currency), action = VALUES(action),
         value = VALUES(value), requirement = VALUES(requirement)`,
      [gymId, productSetId]);
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
        valid_until, cancelled_on, created_at, created_by, modified_at, modified_by)
     SELECT mp.gym_id, mp.member_id, NULL, mp.product_id, mp.id, mp.status, 0, mp.product_name, mp.product_type,
            mp.billing_frequency, mp.units, 1, mp.currency, mp.amount, mp.list_price, mp.direct_discount_percent,
            mp.direct_discount_amount, mp.tax_rate_percent, mp.origin, mp.id, mp.purchased_at, mp.validity_days,
            mp.valid_until, mp.cancelled_on, mp.created_at, mp.created_by, mp.modified_at, mp.modified_by
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
}

/** The purchase a payment request belongs to, if any (the webhook and cleanup know the request, not the purchase). */
export async function syncProductSnapshotForPaymentRequest(tx: Conn, gymId: string, paymentRequestId: number): Promise<void> {
  const { rows } = await tx.query<{ id: number }>(
    'SELECT id FROM member_products_oneoff_snapshot WHERE gym_id = ? AND payment_request_id = ?', [gymId, paymentRequestId]);
  for (const r of rows) await syncProductSnapshotForPurchase(tx, gymId, Number(r.id));
}
