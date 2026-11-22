/**
 * #2125 M6b-51d-7c-2 — `user_memberships` is dropped (Oscar, 2026-11-20: "eliminate `user_memberships`
 * entirely"; option A: no assignment table replaces it).
 *
 * A Membership Plan assignment is its plan snapshots: the anchor (`plan_snapshots.assignment_id = id`)
 * carries its identity and lifecycle (M6b-1, M6b-51c-4), its id comes from `plan_assignment_ids`
 * (migration 455) and every reader goes through `domain/planAssignments.ts`. Since M6b-51d-7c-1
 * (migration 457) no code reads or writes the table and no foreign key points at it.
 *
 * Before dropping it this migration:
 *   - registers in `plan_assignment_ids` every id the table holds that is not there yet (repeatable;
 *     migration 455 already did, this covers a row written by the release before 455's code), so no id
 *     the table handed out can be handed out again;
 *   - refuses to run while a payment request names an assignment that no plan snapshot names, since
 *     that request would lose the only record of what it was for. Such a row is reported, never
 *     guessed at or deleted.
 *
 * A row with no plan snapshot and no payment request (an abandoned Draft from before the Draft was a
 * Product Set version) carries nothing any reader shows; it goes with the table.
 *
 * Deploy order: ship this only in a release after the one carrying migration 457 and its code is
 * live. The API that still writes `user_memberships` (before 457) would fail every request touching
 * it once the table is gone, and its open transactions would hold the drop's metadata lock.
 *
 * One-way: `down` refuses. The table's data is the history of a model the code no longer has.
 */

exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('user_memberships'))) return;

  await knex.raw(`
    INSERT IGNORE INTO plan_assignment_ids (id, gym_id, created_at)
    SELECT id, gym_id, created_at FROM user_memberships`);

  const [orphans] = await knex.raw(`
    SELECT DISTINCT pr.user_membership_id AS id, pr.gym_id
      FROM payment_requests pr
      JOIN user_memberships um ON um.id = pr.user_membership_id
     WHERE NOT EXISTS (SELECT 1 FROM plan_snapshots s
                        WHERE s.source_user_membership_id = um.id AND s.gym_id = um.gym_id)
     LIMIT 20`);
  if (orphans.length > 0) {
    throw new Error(
      `migration 458: payment requests name assignment(s) no plan snapshot names: ${orphans.map((r) => `${r.gym_id}/${r.id}`).join(', ')}`);
  }

  // Nothing else may still point at the table: a foreign key would fail the drop (error 3730), a view
  // would silently become invalid. Report either rather than find out later.
  const [refs] = await knex.raw(`
    SELECT TABLE_NAME AS name, CONSTRAINT_NAME AS ref FROM information_schema.KEY_COLUMN_USAGE
     WHERE REFERENCED_TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME = 'user_memberships'
       AND TABLE_NAME <> 'user_memberships'
    UNION ALL
    SELECT TABLE_NAME, 'view' FROM information_schema.VIEWS
     WHERE TABLE_SCHEMA = DATABASE() AND VIEW_DEFINITION REGEXP '(^|[^a-z_])user_memberships([^a-z_]|$)'`);
  if (refs.length > 0) {
    throw new Error(`migration 458: user_memberships is still referenced: ${refs.map((r) => `${r.name}/${r.ref}`).join(', ')}`);
  }

  await knex.raw('SET SESSION lock_wait_timeout = 30');
  try {
    await knex.raw('DROP TABLE user_memberships');
  } finally {
    await knex.raw('SET SESSION lock_wait_timeout = DEFAULT');
  }
};

exports.down = async () => {
  throw new Error('migration 458 is one-way: user_memberships is retired (#2125 M6b-51d-7c-2)');
};
