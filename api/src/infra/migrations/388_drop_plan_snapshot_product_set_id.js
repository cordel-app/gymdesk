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
 * The `user_membership_members` view (migration 358) read a snapshot's assignment through the column's set; it
 * is recreated over the junction first (a snapshot's assignment is its own `source_user_membership_id`, else
 * the assignment of the earliest set linking it, which is the set that created it), with the same columns and
 * the same "latest snapshot of each assignment" rule, and the original definition is restored on rollback.
 *
 * Existing rows: every snapshot is linked since migration 374; a snapshot no set links (a fixture or a legacy
 * path that wrote the column alone) is linked to the set its column names before the column goes, which is
 * exactly what the sync would have done, so no snapshot becomes unreachable. Nothing else moves.
 *
 * The rollback restores the column from the snapshot's first link (lossy for a snapshot linked by several
 * sets, which is dev data) and re-adds the cascade FK.
 */

const SNAPSHOT_ASSIGNMENT = `COALESCE(s.source_user_membership_id,
       (SELECT ps.user_membership_id FROM product_set_plan_snapshots j
          JOIN product_sets ps ON ps.id = j.product_set_id AND ps.gym_id = s.gym_id
         WHERE j.plan_snapshot_id = s.id ORDER BY j.product_set_id LIMIT 1))`;

const VIEW_OVER_JUNCTION = `
  CREATE OR REPLACE VIEW user_membership_members AS
  SELECT DISTINCT x.user_membership_id AS user_membership_id,
         b.gym_id AS gym_id, b.member_id AS member_id, b.is_owner AS is_owner, b.created_at AS created_at
    FROM (SELECT s.id, s.gym_id, ${SNAPSHOT_ASSIGNMENT} AS user_membership_id,
                 ROW_NUMBER() OVER (PARTITION BY s.gym_id, ${SNAPSHOT_ASSIGNMENT} ORDER BY s.id DESC) AS rn
            FROM plan_snapshots s
           WHERE EXISTS (SELECT 1 FROM product_set_plan_snapshots j WHERE j.plan_snapshot_id = s.id)) x
    JOIN plan_snapshot_beneficiaries b ON b.plan_snapshot_id = x.id AND b.gym_id = x.gym_id
   WHERE x.user_membership_id IS NOT NULL AND x.rn = 1`;

// Migration 358's definition, restored by the rollback.
const VIEW_OVER_COLUMN = `
  CREATE OR REPLACE VIEW user_membership_members AS
  SELECT DISTINCT COALESCE(s.source_user_membership_id, ps.user_membership_id) AS user_membership_id,
         b.gym_id AS gym_id, b.member_id AS member_id, b.is_owner AS is_owner, b.created_at AS created_at
    FROM plan_snapshots s
    JOIN product_sets ps ON ps.id = s.product_set_id AND ps.gym_id = s.gym_id
    JOIN plan_snapshot_beneficiaries b ON b.plan_snapshot_id = s.id AND b.gym_id = s.gym_id
   WHERE COALESCE(s.source_user_membership_id, ps.user_membership_id) IS NOT NULL
     AND s.id = (SELECT MAX(s2.id) FROM plan_snapshots s2
                   JOIN product_sets ps2 ON ps2.id = s2.product_set_id
                  WHERE s2.gym_id = s.gym_id
                    AND COALESCE(s2.source_user_membership_id, ps2.user_membership_id)
                      = COALESCE(s.source_user_membership_id, ps.user_membership_id))`;

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('plan_snapshots', 'product_set_id'))) return;
  await knex.raw(`
    INSERT IGNORE INTO product_set_plan_snapshots (product_set_id, plan_snapshot_id)
    SELECT s.product_set_id, s.id
      FROM plan_snapshots s
      JOIN product_sets ps ON ps.id = s.product_set_id
     WHERE NOT EXISTS (SELECT 1 FROM product_set_plan_snapshots j WHERE j.plan_snapshot_id = s.id)
     ORDER BY s.id`);
  await knex.raw(VIEW_OVER_JUNCTION);
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
  await knex.raw(VIEW_OVER_COLUMN);
};
