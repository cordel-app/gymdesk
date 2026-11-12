/**
 * #2125 M6a — who an assignment covers, read straight from its plan snapshot's
 * `plan_snapshot_beneficiaries`.
 *
 * This is the definition the `user_membership_members` view carried (migration 388), moved into the
 * code so the view can be dropped (migration 407): the latest plan snapshot of each assignment (the
 * snapshot's own `source_user_membership_id`, else the assignment of the earliest Product Set linking
 * it) and that snapshot's beneficiaries, with the view's columns. It is a derived table, used as
 * `FROM ${ASSIGNMENT_BENEFICIARIES} umm` or `JOIN ${ASSIGNMENT_BENEFICIARIES} umm ON …`, and the one
 * place that spelling lives: a reader asks it, never `plan_snapshot_beneficiaries` through a second
 * "which snapshot is the assignment's" rule.
 *
 * Columns: `user_membership_id`, `gym_id`, `member_id`, `is_owner`, `created_at`.
 */
const SNAPSHOT_ASSIGNMENT = `COALESCE(s.source_user_membership_id,
       (SELECT ps.user_membership_id FROM product_set_plan_snapshots j
          JOIN product_sets ps ON ps.id = j.product_set_id AND ps.gym_id = s.gym_id
         WHERE j.plan_snapshot_id = s.id ORDER BY j.product_set_id LIMIT 1))`;

export const ASSIGNMENT_BENEFICIARIES = `(
  SELECT DISTINCT x.user_membership_id AS user_membership_id,
         b.gym_id AS gym_id, b.member_id AS member_id, b.is_owner AS is_owner, b.created_at AS created_at
    FROM (SELECT a.id, a.gym_id, a.user_membership_id,
                 ROW_NUMBER() OVER (PARTITION BY a.gym_id, a.user_membership_id ORDER BY a.id DESC) AS rn
            FROM (SELECT s.id, s.gym_id, ${SNAPSHOT_ASSIGNMENT} AS user_membership_id
                    FROM plan_snapshots s
                   WHERE EXISTS (SELECT 1 FROM product_set_plan_snapshots j
                                   JOIN product_sets ps ON ps.id = j.product_set_id AND ps.gym_id = s.gym_id
                                  WHERE j.plan_snapshot_id = s.id)) a
           WHERE a.user_membership_id IS NOT NULL) x
    JOIN plan_snapshot_beneficiaries b ON b.plan_snapshot_id = x.id AND b.gym_id = x.gym_id
   WHERE x.rn = 1)`;
