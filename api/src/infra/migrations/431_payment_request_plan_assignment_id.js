/**
 * #2125 M6b-34: the second step of the M6b plan's re-key (§3: "`payment_requests.user_membership_id`
 * → `plan_assignment_id`"). Additive: no reader moves and `user_membership_id` stays the source of
 * truth until M6b-4.
 *
 *   plan_assignment_id   the `plan_snapshots.assignment_id` of the assignment the request was raised
 *                        for: the anchor (lowest snapshot id) naming the request's
 *                        `user_membership_id`, the rule `stampAssignmentIds()` gives every snapshot of
 *                        that legacy assignment. NULL where `user_membership_id` is NULL (a product
 *                        purchase, a card verification of a member with no plan, a refund row that
 *                        names none) or where no snapshot names the assignment. Written with the
 *                        attempt by `recordPaymentAttempt()` and kept in step by
 *                        `syncPaymentRequestAssignmentIds()` (`api/plan-assignment-sync.ts`).
 *
 * FK to `plan_snapshots (id)` ON DELETE SET NULL, like migration 430's column, rather than the
 * plan's RESTRICT: while `user_membership_id` is the source of truth a payment request must never be
 * the reason a plan snapshot delete fails. M6b-4 decides RESTRICT once this column is the record.
 * Not in a CHECK (MySQL error 3823). Adding the FK rebuilds the table under ALGORITHM=COPY.
 *
 * Backfill (repeatable: converges on the same values, so `up` may be re-run and
 * `backfillPaymentRequestAssignmentIds` is what a later data repair calls). Only valid while
 * `user_membership_id` is the source of truth, i.e. before M6b-4.
 *
 * `down` drops the column with its key and FK.
 */

async function backfillPaymentRequestAssignmentIds(knex) {
  await knex.raw(`
    UPDATE payment_requests pr
      LEFT JOIN (SELECT gym_id, source_user_membership_id AS um_id, MIN(id) AS anchor_id
                   FROM plan_snapshots WHERE source_user_membership_id IS NOT NULL
                  GROUP BY gym_id, source_user_membership_id) a
             ON a.gym_id = pr.gym_id AND a.um_id = pr.user_membership_id
       SET pr.plan_assignment_id = a.anchor_id
     WHERE NOT (pr.plan_assignment_id <=> a.anchor_id)`);
}

exports.backfillPaymentRequestAssignmentIds = backfillPaymentRequestAssignmentIds;

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('payment_requests', 'plan_assignment_id'))) {
    await knex.raw(`
      ALTER TABLE payment_requests
        ADD COLUMN plan_assignment_id INT UNSIGNED NULL,
        ADD KEY pr_plan_assignment_index (plan_assignment_id),
        ADD CONSTRAINT pr_plan_assignment_fk FOREIGN KEY (plan_assignment_id)
          REFERENCES plan_snapshots (id) ON DELETE SET NULL`);
  }
  await backfillPaymentRequestAssignmentIds(knex);
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('payment_requests', 'plan_assignment_id')) {
    await knex.raw(`
      ALTER TABLE payment_requests
        DROP FOREIGN KEY pr_plan_assignment_fk,
        DROP KEY pr_plan_assignment_index,
        DROP COLUMN plan_assignment_id`);
  }
};
