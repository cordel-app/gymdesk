/**
 * #2126 stage 5c — test fixture only. Production writes a recurring line and its Product snapshot
 * together (`api/recurring-line-writer.ts`); a test that inserts or changes a legacy
 * `member_products_recurrent_snapshot` row by hand calls this to give the version the snapshots a
 * real writer would have written. It is the re-derivation `syncProductSnapshotsOfVersion()` ran
 * before stage 5c, and it reads the legacy table, which is why it lives here and not under `api/`
 * (`product-snapshot-legacy-readers.unit.test.ts`).
 */
import { db, type Tx } from '../infra/db';
import { syncProductSnapshotsOfVersion } from '../api/product-snapshot-sync';
import { syncProductSnapshotJunctions } from '../api/snapshot-junction-sync';

type Conn = Pick<Tx, 'query'>;

/** Re-derives the recurring line snapshots of one version from its legacy rows, then the rest of the sync. */
export async function syncRecurringLinesFixture(tx: Conn, gymId: string, productSetId: number): Promise<void> {
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
        origin, schedule_id, line_ref, created_at, assigned_member_id)
     SELECT s.gym_id, ps.owner_member_id, s.product_set_id, s.product_id, s.id, ps.status, s.is_inherited,
            COALESCE(s.item_name, p.name), COALESCE(s.item_type, p.type), s.item_billing_frequency, s.quantity,
            s.currency, s.unit_price, s.list_unit_price, s.direct_discount_percent, s.starts_at, s.ends_at,
            s.origin, s.schedule_id, s.line_ref, s.created_at, s.assigned_member_id
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
       line_ref = VALUES(line_ref), assigned_member_id = VALUES(assigned_member_id), modified_at = UTC_TIMESTAMP()`,
    [gymId, productSetId]);
  await syncProductSnapshotJunctions(tx, gymId, productSetId);
  await syncProductSnapshotsOfVersion(tx, gymId, productSetId);
}

/** The fixture for every version of one gym that holds a legacy line (outside a transaction). */
export async function syncAllRecurringLinesFixture(gymId: string): Promise<void> {
  const { rows } = await db.query<{ product_set_id: number }>(
    'SELECT DISTINCT product_set_id FROM member_products_recurrent_snapshot WHERE gym_id = ?', [gymId]);
  for (const r of rows) await syncRecurringLinesFixture(db, gymId, Number(r.product_set_id));
}
