/**
 * #2777: an Active Product Set carries every plan its owner is cancelling at its period end.
 *
 * #2659 stage 3 (migration 401) links such a plan to a Product Set **for entitlement only**
 * (`product_set_plan_snapshots.entitlement_only = 1`), which is how the Members App's My Plans keeps
 * showing it as the member's plan until its end date. The link was written when a Draft was built and
 * when a plan was cancelled through `retireProjected()`, so an Active set activated before that stage
 * (or by any other plan-less activation) carries no link: the plan was in neither My Plans nor Past
 * Membership Plans. Since #2777 `activateWithEvents()` links them on every activation; this migration
 * gives the Active sets that already exist the same links.
 *
 * It is `linkCancellingPlans()` (`api/src/api/entitlement-plan-links.ts`) for every Active set at
 * once: each owner's `active_cancel_at_period_end` assignments whose `ends_at` is today or later,
 * linked through the assignment's own plan snapshot (the latest one naming it, the same subselect as
 * `assignmentPlanSnapshotId()`), never a copy. `INSERT IGNORE` on the junction's unique pair makes it
 * repeatable and leaves a plan the set already links (billable or not) as it is. Nothing is billed,
 * projected or edited from these links.
 *
 * `down` is a no-op: the links are derived data, indistinguishable from the ones the application
 * writes, and harmless to keep (the next set re-derives its own from the assignments' stored status).
 */
exports.up = async (knex) => {
  await knex.raw(`
    INSERT IGNORE INTO product_set_plan_snapshots (product_set_id, plan_snapshot_id, entitlement_only)
    SELECT ps.id, x.snapshot_id, 1
      FROM product_sets ps
      JOIN (
        SELECT um.gym_id, um.member_id, um.starts_at, um.id AS um_id,
               (SELECT s9.id FROM product_set_plan_snapshots j9
                  JOIN plan_snapshots s9 ON s9.id = j9.plan_snapshot_id
                  JOIN product_sets p9 ON p9.id = j9.product_set_id
                 WHERE s9.source_user_membership_id = um.id AND s9.gym_id = um.gym_id
                 ORDER BY p9.id DESC, s9.id DESC LIMIT 1) AS snapshot_id
          FROM user_memberships um
         WHERE um.status = 'active_cancel_at_period_end'
           AND um.ends_at IS NOT NULL AND um.ends_at >= UTC_DATE()
      ) x ON x.gym_id = ps.gym_id AND x.member_id = ps.owner_member_id
     WHERE ps.status = 'active' AND x.snapshot_id IS NOT NULL
     ORDER BY ps.id, x.starts_at, x.um_id`);
};

exports.down = async () => {};
