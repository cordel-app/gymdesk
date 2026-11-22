/**
 * #2125 M6b-51c-4: an assignment's lifecycle gets a home on `plan_snapshots`, on the assignment's
 * anchor (`assignment_id = id`), beside the identity M6b-1 put there.
 *
 *   assignment_status        the assignment's status, closed time, end date and last modifier, as
 *   assignment_closed_at     `user_memberships` holds them today. They are facts of the assignment,
 *   assignment_ends_at       not of one snapshot: a snapshot's own `status` / `closed_at` / `ends_at`
 *   assignment_modified_at   stay what the Product Sets that link it read, and writing these changes
 *   assignment_modified_by   nothing any of them reads. Only the anchor carries them (NULL on every
 *                            other snapshot), so a snapshot shared by several Product Sets (M6b-2)
 *                            never has to change for the assignment's lifecycle to be recorded.
 *
 * Additive and dual-written: `writeAssignmentLifecycle()` writes them beside `user_memberships`
 * (#2125 M6b-51c-3, the one writer), `stampAssignmentIds()` seeds a new anchor from the legacy row,
 * and `npm run plan-assignments:validate` compares the two (`assignment_lifecycle_mismatch`).
 * Nothing reads them yet; the next stage moves the snapshot sync and the shared-snapshot rules onto
 * them, which is what lets `user_memberships` go.
 *
 * ADD COLUMN of nullable columns at the end of the table is ALGORITHM=INSTANT on MySQL 8.0.29+ /
 * HeatWave: no rebuild, a brief metadata lock.
 *
 * No CHECK on `assignment_status` yet: the value is only ever the assignment's validated status
 * (`ASSIGNMENT_STATUSES`, `user_memberships_status_check`, `chk_plan_snapshots_status` are the three
 * places a status lives today), and `ADD CONSTRAINT` would rebuild the table under ALGORITHM=COPY. It
 * comes, as `chk_plan_snapshots_assignment_status`, with the stage that makes these columns the source.
 *
 * `assignment_modified_*` is the assignment's modifier; the snapshot's own `modified_*` (migration
 * 427) stays the snapshot's dual-write until that stage decides which readers move.
 *
 * Backfill (repeatable): every anchor naming a `user_memberships` row takes that row's values.
 * `down` drops the columns.
 */

const COLUMNS = [
  'assignment_status', 'assignment_closed_at', 'assignment_ends_at', 'assignment_modified_at', 'assignment_modified_by',
];

/** Repeatable; the runtime repair is `repairAnchorLifecycles()` (`plan-assignments:settle --execute`). */
async function backfillAssignmentLifecycle(knex) {
  await knex.raw(`
    UPDATE plan_snapshots a
      JOIN user_memberships um ON um.id = a.source_user_membership_id AND um.gym_id = a.gym_id
       SET a.assignment_status = um.status, a.assignment_closed_at = um.closed_at,
           a.assignment_ends_at = um.ends_at, a.assignment_modified_at = um.modified_at,
           a.assignment_modified_by = um.modified_by
     WHERE a.assignment_id = a.id
       AND (NOT (a.assignment_status <=> um.status) OR NOT (a.assignment_closed_at <=> um.closed_at)
            OR NOT (a.assignment_ends_at <=> um.ends_at) OR NOT (a.assignment_modified_at <=> um.modified_at)
            OR NOT (a.assignment_modified_by <=> um.modified_by))`);
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('plan_snapshots', COLUMNS[0]))) {
    await knex.raw(`
      ALTER TABLE plan_snapshots
        ADD COLUMN assignment_status VARCHAR(40) NULL,
        ADD COLUMN assignment_closed_at DATETIME NULL,
        ADD COLUMN assignment_ends_at DATE NULL,
        ADD COLUMN assignment_modified_at DATETIME NULL,
        ADD COLUMN assignment_modified_by VARCHAR(255) NULL`);
  }
  await backfillAssignmentLifecycle(knex);
};

exports.down = async function down(knex) {
  const present = [];
  for (const c of COLUMNS) if (await knex.schema.hasColumn('plan_snapshots', c)) present.push(c);
  if (present.length > 0) {
    await knex.raw(`ALTER TABLE plan_snapshots ${present.map((c) => `DROP COLUMN ${c}`).join(', ')}`);
  }
};

exports.backfillAssignmentLifecycle = backfillAssignmentLifecycle;
