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

/**
 * Keeps the recurring Product snapshots of one ProductSet version in step with the version: each
 * line's status and owner follow the set.
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

  // #3026 stage 3d-3c: the Product-target applications a line owns (and the Products each froze) are
  // written onto their Product snapshot rows by their writers (`product-promotion-writer.ts`) and no
  // longer derived from `user_membership_promotions`.
}
