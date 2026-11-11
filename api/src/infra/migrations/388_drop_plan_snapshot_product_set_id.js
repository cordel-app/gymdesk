/**
 * #2125 M5b: a plan snapshot no longer names a Product Set; the junction is the only link.
 *
 * Since M3c every reader asks `product_set_plan_snapshots`, and since M4b-3 one plan snapshot may be linked by
 * several Product Sets (an unmodified plan a Draft reuses from the active set). `plan_snapshots.product_set_id`
 * was by then a second, partial record of that link: it named the set that created the snapshot, which is not
 * necessarily a set that still links it (`ownPlanSnapshot()` re-points the editing set's link at a copy and
 * leaves the original's column alone), and `syncPlanSnapshotJunction()` re-added the link that column implied
 * on every sync. It also carried the ON DELETE CASCADE that deleted a set's snapshots with the set, which is
 * wrong for a shared one (Oscar, 2026-11-08: "Draft-only snapshots are cleaned up according to their
 * references and dependencies. Shared snapshots must be preserved."); a set's own snapshots are now deleted
 * by reference, by `deleteProductSetAndOwnPlanSnapshots()`.
 *
 * Existing rows: every snapshot is linked since migration 374; a snapshot no set links (a fixture or a legacy
 * path that wrote the column alone) is linked to the set its column names before the column goes, which is
 * exactly what the sync would have done, so no snapshot becomes unreachable. Nothing else moves.
 *
 * The rollback restores the column from the snapshot's first link (lossy for a snapshot linked by several
 * sets, which is dev data) and re-adds the cascade FK.
 */

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('plan_snapshots', 'product_set_id'))) return;
  await knex.raw(`
    INSERT IGNORE INTO product_set_plan_snapshots (product_set_id, plan_snapshot_id)
    SELECT s.product_set_id, s.id
      FROM plan_snapshots s
      JOIN product_sets ps ON ps.id = s.product_set_id
     WHERE NOT EXISTS (SELECT 1 FROM product_set_plan_snapshots j WHERE j.plan_snapshot_id = s.id)
     ORDER BY s.id`);
  await knex.raw(`
    ALTER TABLE plan_snapshots
      DROP FOREIGN KEY plan_snapshots_set_fk,
      DROP KEY plan_snapshots_set_index,
      DROP COLUMN product_set_id`);
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('plan_snapshots', 'product_set_id')) return;
  await knex.raw('ALTER TABLE plan_snapshots ADD COLUMN product_set_id INT UNSIGNED NULL AFTER gym_id');
  await knex.raw(`
    UPDATE plan_snapshots s
      JOIN (SELECT plan_snapshot_id, MIN(product_set_id) AS set_id
              FROM product_set_plan_snapshots GROUP BY plan_snapshot_id) j ON j.plan_snapshot_id = s.id
       SET s.product_set_id = j.set_id`);
  await knex.raw('DELETE FROM plan_snapshots WHERE product_set_id IS NULL');
  await knex.raw(`
    ALTER TABLE plan_snapshots
      MODIFY product_set_id INT UNSIGNED NOT NULL,
      ADD KEY plan_snapshots_set_index (product_set_id),
      ADD CONSTRAINT plan_snapshots_set_fk FOREIGN KEY (product_set_id) REFERENCES product_sets (id) ON DELETE CASCADE`);
};
