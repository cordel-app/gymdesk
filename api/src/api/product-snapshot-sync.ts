/**
 * #2126 stage 2 — dual-write of the Product snapshot model (migration 348) beside the legacy
 * rows. Nothing reads these tables yet (stage 3): this module only keeps them equal to what the
 * legacy tables say, in the very transaction that changed the legacy rows.
 *
 * `syncProductSnapshotsOfVersion()` keeps one ProductSet version's recurring line snapshots in
 * step with the version (status, owner) and re-derives the Product-target applications owned by a
 * line and the Products each froze, keyed by the `source_*` columns stage 1 added.
 *
 * #2126 stage 5c: a recurring line is no longer re-derived from its legacy record. Its one writer
 * (`recurring-line-writer.ts`) writes the record and the snapshot from the same values; the
 * re-derivation is now only a test fixture (`src/test/recurringLineSnapshotFixture.ts`), for tests
 * that insert a legacy line by hand.
 *
 * #2126 stage 5b: a bought one-time Product is no longer re-derived from its record. Its writers
 * write the snapshot from their own values (`purchase-writer.ts`); the re-derivation that used to
 * live here is now only a test fixture (`src/test/purchaseSnapshotFixture.ts`), for tests that
 * insert a legacy purchase row by hand.
 */
import type { Tx } from '../infra/db';
import { recurringLineSharedSql } from './recurring-line-sharing';

type Conn = Pick<Tx, 'query'>;

const GRANT_SOURCES: Array<{ kind: string; source: string }> = [
  { kind: 'session', source: 'user_membership_promotion_session_snapshot' },
  { kind: 'oneoff', source: 'user_membership_promotion_oneoff_snapshot' },
  { kind: 'periodical', source: 'user_membership_promotion_periodical_snapshot' },
];

/**
 * Keeps the recurring Product snapshots of one ProductSet version in step with the version: each
 * line's status and owner follow the set, and the Product-target Promotions a line owns (with the
 * Products they froze) are re-derived from their applications.
 */
export async function syncProductSnapshotsOfVersion(tx: Conn, gymId: string, productSetId: number): Promise<void> {
  // #2126 stage 5c: the lines themselves are written by their one writer (`recurring-line-writer.ts`),
  // so only what moves with the set is refreshed here.
  // #2126 stage 5c-2b: only the lines this set alone links follow it. A line another set links is that
  // set's too, and a shared line is never written (`recurring-line-sharing.ts`).
  await tx.query(
    `UPDATE product_periodical_snapshots par
       JOIN product_set_periodical_snapshots lnk ON lnk.product_periodical_snapshot_id = par.id
       JOIN product_sets ps ON ps.id = lnk.product_set_id AND ps.gym_id = par.gym_id
        SET par.status = ps.status, par.member_id = ps.owner_member_id
      WHERE par.gym_id = ? AND lnk.product_set_id = ?
        AND NOT ${recurringLineSharedSql('par.id', 'lnk.product_set_id')}
        AND (par.status <> ps.status OR par.member_id <> ps.owner_member_id)`,
    [gymId, productSetId]);

  // Product-target applications owned by a line of this version.
  const owned = `SELECT ump.id FROM user_membership_promotions ump
                   JOIN promotions pr ON pr.id = ump.promotion_id AND pr.applies_to = 'product'
                  WHERE ump.gym_id = ? AND ump.product_set_id = ? AND ump.recurrent_snapshot_id IS NOT NULL`;
  await tx.query(
    `DELETE pp FROM product_promotion_snapshots pp
       JOIN product_periodical_snapshots par ON par.id = pp.product_periodical_snapshot_id
       JOIN product_set_periodical_snapshots lnk ON lnk.product_periodical_snapshot_id = par.id
      WHERE par.gym_id = ? AND lnk.product_set_id = ?
        AND NOT ${recurringLineSharedSql('par.id', 'lnk.product_set_id')}
        AND (pp.source_application_id IS NULL OR pp.source_application_id NOT IN (${owned}))`,
    [gymId, productSetId, gymId, productSetId]);
  await tx.query(
    `INSERT INTO product_promotion_snapshots
       (gym_id, member_id, product_periodical_snapshot_id, source_application_id, promotion_id, promotion_name,
        status, snapshot, applied_at, applied_by, consumed_at, revoked_at, created_at, created_by,
        modified_at, modified_by)
     SELECT ump.gym_id, par.member_id, par.id, ump.id, ump.promotion_id,
            JSON_UNQUOTE(JSON_EXTRACT(ump.snapshot, '$.name')), ump.status, ump.snapshot, ump.applied_at,
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
         JOIN product_set_periodical_snapshots lnk ON lnk.product_periodical_snapshot_id = par.id
        WHERE g.grant_kind = '${kind}' AND par.gym_id = ? AND lnk.product_set_id = ?
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
         JOIN product_set_periodical_snapshots lnk ON lnk.product_periodical_snapshot_id = par.id
        WHERE par.gym_id = ? AND lnk.product_set_id = ?
       ON DUPLICATE KEY UPDATE
         product_id = VALUES(product_id), product_name = VALUES(product_name), quantity = VALUES(quantity),
         item_type = VALUES(item_type), item_billing_frequency = VALUES(item_billing_frequency),
         unit_price = VALUES(unit_price), currency = VALUES(currency), action = VALUES(action),
         value = VALUES(value), requirement = VALUES(requirement)`,
      [gymId, productSetId]);
  }
}
