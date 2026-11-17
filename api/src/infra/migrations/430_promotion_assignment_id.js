/**
 * #2125 M6b-33: the start of the re-key step of the M6b plan (§3: "`user_membership_promotions.
 * user_membership_id` → re-keyed to `assignment_id`"). Additive: no reader moves and
 * `user_membership_id` stays the source of truth until M6b-4.
 *
 *   assignment_id   the `plan_snapshots.assignment_id` of the assignment the application belongs to:
 *                   the anchor (lowest snapshot id) naming the application's `user_membership_id`,
 *                   which is the rule `stampAssignmentIds()` gives every snapshot of that legacy
 *                   assignment. NULL exactly where `user_membership_id` is NULL (a Product-target
 *                   application, a Draft's application not projected yet, a clone Draft's copy) or
 *                   where no snapshot names the assignment. Dual-written by
 *                   `syncPromotionAssignmentIds()` (`api/plan-assignment-sync.ts`).
 *
 * FK to `plan_snapshots (id)` ON DELETE SET NULL, like `plan_snapshots.replaces_assignment_id`: an
 * anchor is only deleted once no snapshot of its assignment survives (`deleteUnlinkedPlanSnapshots()`),
 * and an application must never be the reason that delete fails. Not in a CHECK (MySQL error 3823).
 * Adding the FK rebuilds the table under ALGORITHM=COPY (foreign_key_checks on); user_membership_promotions
 * is small.
 *
 * Backfill (repeatable: converges on the same values, so `up` may be re-run and
 * `backfillPromotionAssignmentIds` is what a later data repair calls). Only valid while
 * `user_membership_id` is the source of truth, i.e. before M6b-4.
 *
 * `down` drops the column with its key and FK.
 */

async function backfillPromotionAssignmentIds(knex) {
  await knex.raw(`
    UPDATE user_membership_promotions ump
      LEFT JOIN (SELECT gym_id, source_user_membership_id AS um_id, MIN(id) AS anchor_id
                   FROM plan_snapshots WHERE source_user_membership_id IS NOT NULL
                  GROUP BY gym_id, source_user_membership_id) a
             ON a.gym_id = ump.gym_id AND a.um_id = ump.user_membership_id
       SET ump.assignment_id = a.anchor_id
     WHERE NOT (ump.assignment_id <=> a.anchor_id)`);
}

exports.backfillPromotionAssignmentIds = backfillPromotionAssignmentIds;

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('user_membership_promotions', 'assignment_id'))) {
    await knex.raw(`
      ALTER TABLE user_membership_promotions
        ADD COLUMN assignment_id INT UNSIGNED NULL,
        ADD KEY ump_assignment_index (assignment_id),
        ADD CONSTRAINT ump_assignment_fk FOREIGN KEY (assignment_id)
          REFERENCES plan_snapshots (id) ON DELETE SET NULL`);
  }
  await backfillPromotionAssignmentIds(knex);
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('user_membership_promotions', 'assignment_id')) {
    await knex.raw(`
      ALTER TABLE user_membership_promotions
        DROP FOREIGN KEY ump_assignment_fk,
        DROP KEY ump_assignment_index,
        DROP COLUMN assignment_id`);
  }
};
