/**
 * #2125 M6b-36: the fourth step of the M6b plan's re-key (§3: "`product_sets.user_membership_id` →
 * dropped; a set's assignments are its linked snapshots' `assignment_id`s"). Additive: no reader
 * moves and `user_membership_id` stays the source of truth until the readers' stage.
 *
 *   plan_assignment_id   the `plan_snapshots.assignment_id` of the assignment the Product Set
 *                        projects: the anchor (lowest snapshot id) naming the set's
 *                        `user_membership_id`, the rule `stampAssignmentIds()` gives every snapshot
 *                        of that legacy assignment. NULL where `user_membership_id` is NULL (a set
 *                        with no plan, a superseded version whose link moved on, an uncommitted clone)
 *                        or where no snapshot names the assignment yet. Written in the same statement
 *                        as `user_membership_id` by every writer (`PRODUCT_SET_ASSIGNMENT_ANCHOR_SQL`)
 *                        and kept in step by `syncProductSetAssignmentIds()` (`api/plan-assignment-sync.ts`).
 *
 * FK to `plan_snapshots (id)` ON DELETE SET NULL, like migrations 430 and 431: while
 * `user_membership_id` is the source of truth a Product Set must never be the reason a plan snapshot
 * delete fails. Not in a CHECK (MySQL error 3823). Adding the FK rebuilds the table under
 * ALGORITHM=COPY.
 *
 * Backfill (repeatable: converges on the same values, so `up` may be re-run and
 * `backfillProductSetAssignmentIds` is what a later data repair calls). Only valid while
 * `user_membership_id` is the source of truth.
 *
 * `down` drops the column with its key and FK.
 */

async function backfillProductSetAssignmentIds(knex) {
  await knex.raw(`
    UPDATE product_sets ps
      LEFT JOIN (SELECT gym_id, source_user_membership_id AS um_id, MIN(id) AS anchor_id
                   FROM plan_snapshots WHERE source_user_membership_id IS NOT NULL
                  GROUP BY gym_id, source_user_membership_id) a
             ON a.gym_id = ps.gym_id AND a.um_id = ps.user_membership_id
       SET ps.plan_assignment_id = a.anchor_id
     WHERE NOT (ps.plan_assignment_id <=> a.anchor_id)`);
}

exports.backfillProductSetAssignmentIds = backfillProductSetAssignmentIds;

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('product_sets', 'plan_assignment_id'))) {
    await knex.raw(`
      ALTER TABLE product_sets
        ADD COLUMN plan_assignment_id INT UNSIGNED NULL,
        ADD KEY product_sets_plan_assignment_index (plan_assignment_id),
        ADD CONSTRAINT product_sets_plan_assignment_fk FOREIGN KEY (plan_assignment_id)
          REFERENCES plan_snapshots (id) ON DELETE SET NULL`);
  }
  await backfillProductSetAssignmentIds(knex);
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('product_sets', 'plan_assignment_id')) {
    await knex.raw(`
      ALTER TABLE product_sets
        DROP FOREIGN KEY product_sets_plan_assignment_fk,
        DROP KEY product_sets_plan_assignment_index,
        DROP COLUMN plan_assignment_id`);
  }
};
