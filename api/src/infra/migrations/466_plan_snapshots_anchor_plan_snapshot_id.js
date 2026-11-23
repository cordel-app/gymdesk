/**
 * #2125 N3c — `plan_snapshots.assignment_id` is renamed `anchor_plan_snapshot_id`.
 *
 * Since N1 (migration 461) an assignment's id is its anchor plan snapshot's id, and since N2
 * (migration 462) this column is the only record of which assignment a snapshot belongs to: it names
 * the anchor (the anchor row names itself). Oscar's decision on #2125 renames it for what it points
 * at, the name `payment_requests` already uses for the same reference since N3a (migration 464).
 *
 * A rename only: the type, the nullability, the self FK `plan_snapshots_assignment_fk` (ON DELETE
 * RESTRICT) and the index `plan_snapshots_assignment_index` follow the column, which MySQL 8 keeps on
 * `RENAME COLUMN` as metadata (no table copy). The anchor's lifecycle columns (`assignment_status`,
 * `assignment_closed_at`, …) and `replaces_assignment_id` keep their names. Re-runnable: each
 * direction checks which name the column has.
 */
exports.up = async (knex) => {
  const has = (c) => knex.schema.hasColumn('plan_snapshots', c);
  if ((await has('assignment_id')) && !(await has('anchor_plan_snapshot_id'))) {
    await knex.raw('SET SESSION lock_wait_timeout = 30');
    await knex.raw('ALTER TABLE plan_snapshots RENAME COLUMN assignment_id TO anchor_plan_snapshot_id');
  }
};

exports.down = async (knex) => {
  const has = (c) => knex.schema.hasColumn('plan_snapshots', c);
  if ((await has('anchor_plan_snapshot_id')) && !(await has('assignment_id'))) {
    await knex.raw('SET SESSION lock_wait_timeout = 30');
    await knex.raw('ALTER TABLE plan_snapshots RENAME COLUMN anchor_plan_snapshot_id TO assignment_id');
  }
};
