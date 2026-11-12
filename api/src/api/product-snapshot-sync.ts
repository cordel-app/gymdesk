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
 *
 * #2126 stage 5b: a bought one-time Product is no longer re-derived from its record. Its writers
 * write the snapshot from their own values (`purchase-writer.ts`); the re-derivation that used to
 * live here is now only a test fixture (`src/test/purchaseSnapshotFixture.ts`), for tests that
 * insert a legacy purchase row by hand.
 */
import type { Tx } from '../infra/db';
import { syncProductSnapshotJunctions } from './snapshot-junction-sync';

type Conn = Pick<Tx, 'query'>;

const GRANT_SOURCES: Array<{ kind: string; source: string }> = [
  { kind: 'session', source: 'user_membership_promotion_session_snapshot' },
  { kind: 'oneoff', source: 'user_membership_promotion_oneoff_snapshot' },
  { kind: 'periodical', source: 'user_membership_promotion_periodical_snapshot' },
];

/** Re-derives the recurring Product snapshots of one ProductSet version from its legacy rows. */
export async function syncProductSnapshotsOfVersion(tx: Conn, gymId: string, productSetId: number): Promise<void> {
  // A line that no longer exists takes its snapshot, promotions, grants and junction row with it (cascade).
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
  await syncProductSnapshotJunctions(tx, gymId, productSetId);
}
