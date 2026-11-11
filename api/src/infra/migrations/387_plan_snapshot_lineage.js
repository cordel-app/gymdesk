/**
 * #2125 M5a: a plan snapshot records the snapshot it was copied from, and "inherited" is derived.
 *
 * Since M4b-3 a Draft links the plan snapshots it reuses unchanged, and the first writer that edits one
 * copies it (`ownPlanSnapshot()` -> `copyPlanSnapshotToVersion()`). Until now the copy said it was
 * inherited through `plan_snapshots.is_inherited = 1`; that flag is a second record of one fact (the copy
 * exists because it replaced a shared snapshot) and M5 drops it. What replaces it is lineage:
 * `copied_from_plan_snapshot_id`, written by the copy and nothing else, and `planSnapshotInheritedSql()`
 * derives "inherited by set X" from it or from the snapshot being linked by X's previous set.
 *
 * Self FK ON DELETE SET NULL: a source snapshot is only deleted with its Product Set (a discarded Draft
 * deletes its own copies, never their sources), and a lineage pointing at a deleted row must not block
 * that delete. ADD CONSTRAINT rebuilds the table under ALGORITHM=COPY; plan_snapshots is small.
 *
 * Existing rows: a copy carrying is_inherited = 1 gets its lineage from the matching plan snapshot of its
 * set's previous set (same Membership Plan, same assignment), the copy's only possible source; a copy with
 * no such match keeps NULL (dev data, #2125 decision 2: no historical migration is owed). The flag is then
 * dropped. The rollback is lossy (dev data): it restores the flag only on rows with a lineage.
 * `product_*_snapshots.is_inherited` (#2126) and the Promotion applications' flag are untouched.
 */

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('plan_snapshots', 'copied_from_plan_snapshot_id'))) {
    await knex.raw(`
      ALTER TABLE plan_snapshots
        ADD COLUMN copied_from_plan_snapshot_id INT UNSIGNED NULL,
        ADD KEY plan_snapshots_copied_from_index (copied_from_plan_snapshot_id),
        ADD CONSTRAINT plan_snapshots_copied_from_fk FOREIGN KEY (copied_from_plan_snapshot_id)
          REFERENCES plan_snapshots (id) ON DELETE SET NULL`);
  }
  if (await knex.schema.hasColumn('plan_snapshots', 'is_inherited')) {
    // The lowest matching id, so a set holding the same plan twice gets one deterministic source.
    await knex.raw(`
      UPDATE plan_snapshots c
        JOIN (SELECT c2.id AS copy_id, MIN(src.id) AS src_id
                FROM plan_snapshots c2
                JOIN product_sets ps ON ps.id = c2.product_set_id
                JOIN product_set_plan_snapshots pj ON pj.product_set_id = ps.previous_product_set_id
                JOIN plan_snapshots src ON src.id = pj.plan_snapshot_id
                                       AND src.membership_plan_id = c2.membership_plan_id
                                       AND src.source_user_membership_id <=> c2.source_user_membership_id
               WHERE c2.is_inherited = 1 AND c2.copied_from_plan_snapshot_id IS NULL AND src.id <> c2.id
               GROUP BY c2.id) m ON m.copy_id = c.id
         SET c.copied_from_plan_snapshot_id = m.src_id`);
    await knex.raw('ALTER TABLE plan_snapshots DROP COLUMN is_inherited');
  }
};

exports.down = async (knex) => {
  if (!(await knex.schema.hasColumn('plan_snapshots', 'is_inherited'))) {
    await knex.raw('ALTER TABLE plan_snapshots ADD COLUMN is_inherited TINYINT(1) NOT NULL DEFAULT 0');
    await knex.raw('UPDATE plan_snapshots SET is_inherited = 1 WHERE copied_from_plan_snapshot_id IS NOT NULL');
  }
  if (await knex.schema.hasColumn('plan_snapshots', 'copied_from_plan_snapshot_id')) {
    await knex.raw(`
      ALTER TABLE plan_snapshots
        DROP FOREIGN KEY plan_snapshots_copied_from_fk,
        DROP KEY plan_snapshots_copied_from_index,
        DROP COLUMN copied_from_plan_snapshot_id`);
  }
};
