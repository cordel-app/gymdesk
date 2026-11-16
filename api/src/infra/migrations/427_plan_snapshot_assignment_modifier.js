/**
 * #2125 M6b-30: `plan_snapshots` gets the assignment's last modification, the one assignment-level
 * fact the readers still on `user_memberships` need that no snapshot carries (the Member card's
 * plan history and `LIST_SELECT` report who last changed the assignment and when). Additive: no
 * reader moves and `user_memberships` stays the source of truth until M6b-4.
 *
 *   modified_at, modified_by   the assignment's own `user_memberships.modified_at` / `modified_by`
 *                              (#1182's plain-text actor), dual-written by `syncPlanAssignment()` on
 *                              the rule it already applies to `deleted_at` / `deleted_by`: onto a
 *                              snapshot no other Product Set links. A copy carries its source's.
 *
 * No CHECK, no index: nothing filters on them. ADD COLUMN of two nullable columns is instant in
 * MySQL 8 (ALGORITHM=INSTANT), and plan_snapshots is small anyway.
 *
 * Backfill (repeatable): every snapshot naming a `user_memberships` row takes that row's pair. The
 * columns are new, so shared snapshots are filled too and nothing is overwritten; only valid while
 * `user_memberships` is the source of truth, i.e. before M6b-4.
 *
 * `down` drops the two columns.
 */

async function backfillPlanAssignmentModifier(knex) {
  await knex.raw(`
    UPDATE plan_snapshots s
      JOIN user_memberships um ON um.id = s.source_user_membership_id AND um.gym_id = s.gym_id
       SET s.modified_at = um.modified_at,
           s.modified_by = um.modified_by
     WHERE NOT (s.modified_at <=> um.modified_at) OR NOT (s.modified_by <=> um.modified_by)`);
}

exports.backfillPlanAssignmentModifier = backfillPlanAssignmentModifier;

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('plan_snapshots', 'modified_at'))) {
    await knex.raw(`
      ALTER TABLE plan_snapshots
        ADD COLUMN modified_at DATETIME NULL,
        ADD COLUMN modified_by VARCHAR(255) NULL`);
  }
  await backfillPlanAssignmentModifier(knex);
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('plan_snapshots', 'modified_at')) {
    await knex.raw('ALTER TABLE plan_snapshots DROP COLUMN modified_at, DROP COLUMN modified_by');
  }
};
