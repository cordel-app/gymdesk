/**
 * #2125 M6a — drop the `user_membership_members` view.
 *
 * Coverage is the plan snapshot's `plan_snapshot_beneficiaries` since migration 358, and the view was
 * only a read of it keyed by assignment (migration 388's definition). That read now lives in the code
 * as one derived table, `ASSIGNMENT_BENEFICIARIES` (`api/src/domain/assignmentBeneficiaries.ts`), which
 * every former reader of the view asks, so the view is dropped — the owner's 2026-11 decision 4 on
 * #2125 ("remove the `user_membership_members` view once its responsibilities are migrated").
 *
 * No row moves: a view holds no data. The rollback recreates migration 388's definition, and is only
 * valid together with reverting the M6a application code, which no longer reads the view.
 */

const SNAPSHOT_ASSIGNMENT = `COALESCE(s.source_user_membership_id,
       (SELECT ps.user_membership_id FROM product_set_plan_snapshots j
          JOIN product_sets ps ON ps.id = j.product_set_id AND ps.gym_id = s.gym_id
         WHERE j.plan_snapshot_id = s.id ORDER BY j.product_set_id LIMIT 1))`;

const VIEW_OVER_JUNCTION = `
  CREATE OR REPLACE VIEW user_membership_members AS
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
   WHERE x.rn = 1`;

exports.up = async (knex) => {
  await knex.raw('DROP VIEW IF EXISTS user_membership_members');
};

exports.down = async (knex) => {
  await knex.raw(VIEW_OVER_JUNCTION);
};
