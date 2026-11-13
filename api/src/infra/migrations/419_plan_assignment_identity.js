/**
 * #2125 M6b-1: `plan_snapshots` gets the assignment's identity and the lifecycle columns that still
 * live only on `user_memberships`. Additive: no reader moves, nothing is dropped, and
 * `user_memberships` stays the source of truth until M6b-4.
 *
 *   assignment_id          the stable identity of the logical Membership Plan assignment: the id of
 *                          the first snapshot of the assignment. A first snapshot has
 *                          `assignment_id = id`; a copy carries its source's. Self FK ON DELETE
 *                          RESTRICT, so the anchor cannot be deleted while another snapshot of the
 *                          assignment exists (Oscar: "protect the assignment identity anchor from
 *                          accidental deletion"). It is a column of this table, not a second entity.
 *                          Nullable for now: an AUTO_INCREMENT row cannot name itself in its own
 *                          INSERT, so the writers stamp it right after (`stampAssignmentId()`), and a
 *                          later stage makes it NOT NULL once `plan-assignments:validate` is clean.
 *   purchased_at,          the assignment-level facts `user_memberships` holds and the snapshot did
 *   replace_on_activation, not. `replaces_assignment_id` is `replaces_user_membership_id` expressed
 *   replaces_assignment_id,as the replaced assignment's `assignment_id` (SET NULL, as the legacy FK).
 *   deleted_at, deleted_by
 *   status                 widened to VARCHAR(40) and the CHECK to `ASSIGNMENT_STATUSES`
 *                          (`domain/assignmentStatus.ts`): `active_cancel_at_period_end` is 27
 *                          characters and was written as `cancelled` until now.
 *
 * ALTER ... ADD CONSTRAINT rebuilds the table under ALGORITHM=COPY; plan_snapshots is small.
 *
 * Backfill (repeatable: every statement converges on the same values, so `up` may be re-run and
 * `backfillPlanAssignmentIdentity` is what a later data repair would call):
 *   1. every snapshot naming a `user_memberships` row takes the lowest snapshot id naming that row;
 *   2. a snapshot naming none inherits its copy source's assignment, walked down the lineage;
 *   3. anything left is its own assignment;
 *   4. the assignment-level facts are copied from the `user_memberships` row each snapshot names
 *      (every snapshot, shared ones included: the columns are new, so nothing is overwritten. This
 *      step is only valid while `user_memberships` is the source of truth, i.e. before M6b-4).
 * Status and dates are left to `syncPlanSnapshot()`'s existing rule, except the one value the old
 * CHECK could not hold: an un-shared snapshot of an Active set whose assignment cancels at its period
 * end takes `active_cancel_at_period_end` instead of `cancelled`.
 *
 * `down` drops the columns and narrows the CHECK again (mapping the new value back to `cancelled`).
 */

const STATUSES = "'draft','pending_payment','active','paused','active_cancel_at_period_end','cancelled','expired','superseded'";
const OLD_STATUSES = "'draft','pending_payment','active','paused','cancelled','expired','superseded'";

/** Makes `chk_plan_snapshots_status` the given list unless it already is (`isWanted` reads its clause). */
async function setStatusCheck(knex, statuses, isWanted) {
  const [rows] = await knex.raw(
    `SELECT cc.CHECK_CLAUSE AS clause FROM information_schema.CHECK_CONSTRAINTS cc
      WHERE cc.CONSTRAINT_SCHEMA = DATABASE() AND cc.CONSTRAINT_NAME = 'chk_plan_snapshots_status'`);
  const chk = rows && rows[0];
  if (chk && isWanted(String(chk.clause))) return;
  if (chk) await knex.raw('ALTER TABLE plan_snapshots DROP CHECK chk_plan_snapshots_status');
  await knex.raw(`ALTER TABLE plan_snapshots ADD CONSTRAINT chk_plan_snapshots_status CHECK (status IN (${statuses}))`);
}

async function backfillPlanAssignmentIdentity(knex) {
  await knex.raw(`
    UPDATE plan_snapshots s
      JOIN (SELECT gym_id, source_user_membership_id AS um_id, MIN(id) AS anchor_id
              FROM plan_snapshots WHERE source_user_membership_id IS NOT NULL
             GROUP BY gym_id, source_user_membership_id) a
        ON a.gym_id = s.gym_id AND a.um_id = s.source_user_membership_id
       SET s.assignment_id = a.anchor_id
     WHERE NOT (s.assignment_id <=> a.anchor_id)`);
  await knex.raw(`
    UPDATE plan_snapshots SET assignment_id = id
     WHERE assignment_id IS NULL AND source_user_membership_id IS NULL AND copied_from_plan_snapshot_id IS NULL`);
  // A copy that names no assignment of its own follows its source, one lineage step per pass.
  // Each pass resolves at least one row or ends the loop, so it terminates whatever the depth.
  for (;;) {
    const [res] = await knex.raw(`
      UPDATE plan_snapshots s
        JOIN plan_snapshots src ON src.id = s.copied_from_plan_snapshot_id AND src.gym_id = s.gym_id
         SET s.assignment_id = src.assignment_id
       WHERE s.assignment_id IS NULL AND src.assignment_id IS NOT NULL`);
    if (!res || !res.affectedRows) break;
  }
  await knex.raw('UPDATE plan_snapshots SET assignment_id = id WHERE assignment_id IS NULL');

  await knex.raw(`
    UPDATE plan_snapshots s
      JOIN user_memberships um ON um.id = s.source_user_membership_id AND um.gym_id = s.gym_id
      LEFT JOIN (SELECT gym_id, source_user_membership_id AS um_id, MIN(id) AS anchor_id
                   FROM plan_snapshots WHERE source_user_membership_id IS NOT NULL
                  GROUP BY gym_id, source_user_membership_id) r
             ON r.gym_id = um.gym_id AND r.um_id = um.replaces_user_membership_id
       SET s.purchased_at = um.purchased_at,
           s.replace_on_activation = um.replace_on_activation,
           s.replaces_assignment_id = r.anchor_id,
           s.deleted_at = um.deleted_at,
           s.deleted_by = um.deleted_by`);

  await knex.raw(`
    UPDATE plan_snapshots s
      JOIN product_set_plan_snapshots psj ON psj.plan_snapshot_id = s.id AND psj.entitlement_only = 0
      JOIN product_sets ps ON ps.id = psj.product_set_id AND ps.gym_id = s.gym_id AND ps.status = 'active'
      JOIN user_memberships um ON um.id = COALESCE(s.source_user_membership_id, ps.user_membership_id)
                              AND um.gym_id = s.gym_id AND um.status = 'active_cancel_at_period_end'
       SET s.status = 'active_cancel_at_period_end'
     WHERE s.status = 'cancelled'
       AND NOT EXISTS (SELECT 1 FROM product_set_plan_snapshots sh
                        WHERE sh.plan_snapshot_id = s.id AND sh.product_set_id <> psj.product_set_id)`);
}

exports.backfillPlanAssignmentIdentity = backfillPlanAssignmentIdentity;

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('plan_snapshots', 'assignment_id'))) {
    await knex.raw(`
      ALTER TABLE plan_snapshots
        MODIFY COLUMN status VARCHAR(40) NOT NULL DEFAULT 'draft',
        ADD COLUMN assignment_id INT UNSIGNED NULL,
        ADD COLUMN purchased_at DATETIME NULL,
        ADD COLUMN replace_on_activation TINYINT(1) NOT NULL DEFAULT 0,
        ADD COLUMN replaces_assignment_id INT UNSIGNED NULL,
        ADD COLUMN deleted_at DATETIME NULL,
        ADD COLUMN deleted_by VARCHAR(255) NULL,
        ADD KEY plan_snapshots_assignment_index (assignment_id, id),
        ADD KEY plan_snapshots_replaces_index (replaces_assignment_id),
        ADD CONSTRAINT plan_snapshots_assignment_fk FOREIGN KEY (assignment_id)
          REFERENCES plan_snapshots (id) ON DELETE RESTRICT,
        ADD CONSTRAINT plan_snapshots_replaces_fk FOREIGN KEY (replaces_assignment_id)
          REFERENCES plan_snapshots (id) ON DELETE SET NULL`);
  }
  // Guarded on its own state, so a run that died between the statements above is finished by a re-run.
  await setStatusCheck(knex, STATUSES, (clause) => clause.includes('active_cancel_at_period_end'));
  await backfillPlanAssignmentIdentity(knex);
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('plan_snapshots', 'assignment_id')) {
    await knex.raw("UPDATE plan_snapshots SET status = 'cancelled' WHERE status = 'active_cancel_at_period_end'");
    await knex.raw(`
      ALTER TABLE plan_snapshots
        DROP FOREIGN KEY plan_snapshots_assignment_fk,
        DROP FOREIGN KEY plan_snapshots_replaces_fk,
        DROP KEY plan_snapshots_assignment_index,
        DROP KEY plan_snapshots_replaces_index,
        DROP COLUMN assignment_id,
        DROP COLUMN purchased_at,
        DROP COLUMN replace_on_activation,
        DROP COLUMN replaces_assignment_id,
        DROP COLUMN deleted_at,
        DROP COLUMN deleted_by`);
  }
  await knex.raw("UPDATE plan_snapshots SET status = 'cancelled' WHERE status = 'active_cancel_at_period_end'");
  await setStatusCheck(knex, OLD_STATUSES, (clause) => !clause.includes('active_cancel_at_period_end'));
  await knex.raw("ALTER TABLE plan_snapshots MODIFY COLUMN status VARCHAR(20) NOT NULL DEFAULT 'draft'");
};
