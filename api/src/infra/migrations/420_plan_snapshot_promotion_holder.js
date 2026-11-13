/**
 * #2125 M6b-2: a plan snapshot copied for a lifecycle change reuses its source's Promotion snapshots.
 *
 * A lifecycle change (pause, resume, cancellation, the end-of-period sweep) on a plan snapshot that
 * more than one Product Set links is written on a copy, so the snapshot the other sets link keeps
 * its state. Oscar's rule for that copy: it keeps its relationship with the exact same Promotion
 * snapshot records; none is created or copied, and no `plan_snapshot_promotions` table is added.
 *
 * `plan_promotion_snapshots.plan_snapshot_id` names one plan snapshot, so the minimum change is a
 * pointer on the copy:
 *
 *   promotions_plan_snapshot_id   the plan snapshot whose `plan_promotion_snapshots` rows this
 *                                 snapshot uses. NULL (every existing row, and every snapshot that
 *                                 is not a lifecycle copy) means its own. Self FK ON DELETE SET NULL:
 *                                 the application never deletes a snapshot another one points at
 *                                 (`deleteUnlinkedPlanSnapshots()`), and SET NULL keeps a bulk
 *                                 delete of a gym's snapshots (test cleanup, the dev reset) possible.
 *
 * Additive, no backfill: a NULL pointer reads exactly as before. ADD COLUMN ... NULL with a key and
 * a FK; ADD CONSTRAINT rebuilds the table under ALGORITHM=COPY, and plan_snapshots is small. The code
 * reads the column unconditionally, so this runs before the new API image serves traffic.
 */
exports.up = async (knex) => {
  if (await knex.schema.hasColumn('plan_snapshots', 'promotions_plan_snapshot_id')) return;
  await knex.raw(`
    ALTER TABLE plan_snapshots
      ADD COLUMN promotions_plan_snapshot_id INT UNSIGNED NULL,
      ADD KEY plan_snapshots_promotions_holder_index (promotions_plan_snapshot_id),
      ADD CONSTRAINT plan_snapshots_promotions_holder_fk FOREIGN KEY (promotions_plan_snapshot_id)
        REFERENCES plan_snapshots (id) ON DELETE SET NULL`);
};

exports.down = async (knex) => {
  if (!(await knex.schema.hasColumn('plan_snapshots', 'promotions_plan_snapshot_id'))) return;
  await knex.raw(`
    ALTER TABLE plan_snapshots
      DROP FOREIGN KEY plan_snapshots_promotions_holder_fk,
      DROP KEY plan_snapshots_promotions_holder_index,
      DROP COLUMN promotions_plan_snapshot_id`);
};
