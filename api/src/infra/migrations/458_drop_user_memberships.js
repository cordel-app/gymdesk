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

  await knex.raw('SET SESSION lock_wait_timeout = 30');
  await knex.raw('DROP TABLE user_memberships');
};

exports.down = async () => {
  throw new Error('migration 458 is one-way: user_memberships is retired (#2125 M6b-51d-7c-2)');
};
