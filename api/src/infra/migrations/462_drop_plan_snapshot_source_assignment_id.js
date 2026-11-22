/**
 * #2125 N2 — `plan_snapshots.assignment_id` is the one record of which assignment a plan snapshot
 * belongs to, and `source_user_membership_id` is dropped.
 *
 * Since N1 (migration 461) a snapshot naming an assignment carries that assignment's id twice: in
 * `source_user_membership_id` and in `assignment_id`, the two equal by construction. The only thing
 * the first said that the second did not is whether a snapshot names an assignment at all: a snapshot
 * no assignment was opened on (a Members App Draft, a plan added to a version beside its first) held
 * `source_user_membership_id = NULL` and an `assignment_id` of its own. From this migration on such a
 * snapshot holds `assignment_id = NULL` too (Oscar's decision on #2125: "a cart/draft that has not
 * been confirmed has no permanent anchor"), so `assignment_id` says both things and the other column
 * goes:
 *
 *   1. refuses, listing them, while a named snapshot's two values differ (`plan-assignments:validate`
 *      reports it as `assignment_id_is_not_anchor_id`);
 *   2. refuses while a snapshot naming no assignment is anchored on a named one, clears the links
 *      (`product_sets` / `payment_requests.plan_assignment_id`, `replaces_assignment_id`) to a snapshot
 *      naming none, and clears the identity and anchor lifecycle columns of every such snapshot;
 *   3. drops `source_user_membership_id` and its index.
 *
 * `down` re-adds the column and fills it from `assignment_id`; the self-anchors of unnamed snapshots
 * are not restored (nothing read them).
 */

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('plan_snapshots', 'source_user_membership_id'))) return;

  const [drift] = await knex.raw(
    `SELECT id, gym_id, source_user_membership_id AS um, assignment_id FROM plan_snapshots
      WHERE source_user_membership_id IS NOT NULL AND NOT (source_user_membership_id <=> assignment_id)
      ORDER BY id LIMIT 20`);
  if (drift.length > 0) {
    throw new Error(
      'migration 462: plan snapshot(s) whose assignment id is not their anchor: '
      + drift.map((r) => `${r.id} (gym ${r.gym_id}, names ${r.um}, anchored on ${r.assignment_id})`).join(', ')
      + '. Run `npm run plan-assignments:validate` and correct them first.');
  }

  // A snapshot naming no assignment that is nevertheless anchored on a named one would silently leave
  // that assignment below; refuse it rather than guess which it belongs to.
  const [orphaned] = await knex.raw(
    `SELECT s.id, s.gym_id, s.assignment_id FROM plan_snapshots s
       JOIN plan_snapshots a ON a.id = s.assignment_id
      WHERE s.source_user_membership_id IS NULL AND a.source_user_membership_id IS NOT NULL
      ORDER BY s.id LIMIT 20`);
  if (orphaned.length > 0) {
    throw new Error(
      'migration 462: unnamed plan snapshot(s) anchored on a named assignment: '
      + orphaned.map((r) => `${r.id} (gym ${r.gym_id}, anchored on ${r.assignment_id})`).join(', '));
  }

  // A link to a snapshot that names no assignment names nothing once the self-anchor goes: cleared in
  // the same step (all three are ON DELETE SET NULL, so the FK would not catch it).
  const UNNAMED = 'SELECT id FROM plan_snapshots WHERE source_user_membership_id IS NULL';
  await knex.raw(`UPDATE product_sets SET plan_assignment_id = NULL WHERE plan_assignment_id IN (SELECT id FROM (${UNNAMED}) u)`);
  await knex.raw(`UPDATE payment_requests SET plan_assignment_id = NULL WHERE plan_assignment_id IN (SELECT id FROM (${UNNAMED}) u)`);
  await knex.raw(`UPDATE plan_snapshots s JOIN (${UNNAMED}) u ON u.id = s.replaces_assignment_id SET s.replaces_assignment_id = NULL`);

  await knex.raw(
    `UPDATE plan_snapshots
        SET assignment_id = NULL, assignment_status = NULL, assignment_closed_at = NULL,
            assignment_ends_at = NULL, assignment_modified_at = NULL, assignment_modified_by = NULL
      WHERE source_user_membership_id IS NULL`);

  await knex.raw('SET SESSION lock_wait_timeout = 30');
  try {
    await knex.raw('ALTER TABLE plan_snapshots DROP INDEX plan_snapshots_um_index, DROP COLUMN source_user_membership_id');
  } finally {
    await knex.raw('SET SESSION lock_wait_timeout = DEFAULT');
  }
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('plan_snapshots', 'source_user_membership_id')) return;
  await knex.raw(
    `ALTER TABLE plan_snapshots ADD COLUMN source_user_membership_id INT UNSIGNED NULL,
       ADD INDEX plan_snapshots_um_index (source_user_membership_id)`);
  await knex.raw('UPDATE plan_snapshots SET source_user_membership_id = assignment_id WHERE assignment_id IS NOT NULL');
};
