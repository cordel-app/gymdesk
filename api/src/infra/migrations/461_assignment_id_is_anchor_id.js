/**
 * #2125 N1 — a Membership Plan assignment's id is its anchor plan snapshot's id (Oscar's architecture
 * decision on #2125, 2026-11-22: "the canonical ID of a confirmed Membership Plan assignment is the
 * `id` of its anchor row in `plan_snapshots`"; no production data exists, so no compatibility period).
 *
 * From this migration on, `openAssignmentOnSet()` opens an assignment on its own plan snapshot and
 * names it with that snapshot's id, so the id the API, the payment requests and the audit log carry
 * equals the anchor. This migration makes the existing rows say the same, then drops the registry:
 *
 *   1. refuses, listing them, while an assignment id names more than one anchor, a named snapshot has
 *      none, or one anchor is named by two assignment ids (`plan-assignments:validate` reports these):
 *      the rewrite below needs exactly one anchor per id and one id per anchor;
 *   2. deletes the `user_membership` audit rows of an assignment no snapshot names any more (a
 *      discarded Draft): their id identifies nothing, and kept they could be read as a later
 *      assignment's once ids are anchor ids;
 *   3. re-keys the remaining `user_membership` audit rows and `payment_requests.user_membership_id`
 *      (the request's own `plan_assignment_id` where no snapshot names the assignment any more, NULL
 *      without one) from the registry id to the anchor id, then
 *      `plan_snapshots.source_user_membership_id` itself (last, since the map is read from it);
 *   4. drops `plan_assignment_ids`.
 *
 * `source_user_membership_id` stays, equal to `assignment_id`, until N2 moves its readers. Ids recorded
 * inside audit JSON values (`previous_values`, `new_values`) are history and are not rewritten.
 *
 * Deploy order: run it together with the API that opens assignments on their snapshot. Between the
 * two, the previous API still allocates registry ids (before the DROP) or fails to create an
 * assignment (after it); dev only, so a few minutes of that is accepted.
 * `down` recreates the registry with every id a snapshot names; the original registry ids are not
 * recoverable (the dev data was declared disposable).
 */

exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('plan_assignment_ids'))) return;

  const [split] = await knex.raw(
    `SELECT gym_id, source_user_membership_id AS um, COUNT(DISTINCT assignment_id) AS anchors,
            SUM(assignment_id IS NULL) AS unanchored
       FROM plan_snapshots WHERE source_user_membership_id IS NOT NULL
      GROUP BY gym_id, source_user_membership_id
     HAVING COUNT(DISTINCT assignment_id) > 1 OR SUM(assignment_id IS NULL) > 0
      ORDER BY um LIMIT 20`);
  if (split.length > 0) {
    throw new Error(
      'migration 461: assignment id(s) without exactly one anchor: '
      + split.map((r) => `${r.um} (gym ${r.gym_id}, ${r.anchors} anchor(s), ${r.unanchored} unanchored)`).join(', ')
      + '. Run `npm run plan-assignments:validate` and correct them first.');
  }
  const [merged] = await knex.raw(
    `SELECT gym_id, assignment_id, COUNT(DISTINCT source_user_membership_id) AS ids
       FROM plan_snapshots WHERE source_user_membership_id IS NOT NULL
      GROUP BY gym_id, assignment_id HAVING COUNT(DISTINCT source_user_membership_id) > 1
      ORDER BY assignment_id LIMIT 20`);
  if (merged.length > 0) {
    throw new Error(
      'migration 461: anchor(s) named by more than one assignment id (their history would merge): '
      + merged.map((r) => `${r.assignment_id} (gym ${r.gym_id}, ${r.ids} ids)`).join(', '));
  }

  // `audit_logs.entity_id` is text, in a collation the connection's literals need not share, so it is
  // compared as a number (an assignment's entity id always is one; anything else matches nothing).
  const ENTITY_ID = "IF(a.entity_id REGEXP '^[0-9]+$', CAST(a.entity_id AS UNSIGNED), NULL)";
  // One anchor per assignment id (checked above), so the id → anchor map is this derived table.
  const MAP = `(SELECT gym_id, source_user_membership_id AS um, MIN(assignment_id) AS anchor FROM plan_snapshots
                 WHERE source_user_membership_id IS NOT NULL GROUP BY gym_id, source_user_membership_id)`;

  await knex.raw(
    `DELETE a FROM audit_logs a
      WHERE a.entity_type = 'user_membership'
        AND NOT EXISTS (SELECT 1 FROM plan_snapshots s
                         WHERE s.gym_id = a.gym_id AND s.source_user_membership_id = ${ENTITY_ID})`);
  await knex.raw(
    `UPDATE audit_logs a JOIN ${MAP} m ON m.gym_id = a.gym_id AND m.um = ${ENTITY_ID}
        SET a.entity_id = CAST(m.anchor AS CHAR)
      WHERE a.entity_type = 'user_membership'`);
  await knex.raw(
    `UPDATE payment_requests pr LEFT JOIN ${MAP} m ON m.gym_id = pr.gym_id AND m.um = pr.user_membership_id
        SET pr.user_membership_id = COALESCE(m.anchor, pr.plan_assignment_id)
      WHERE pr.user_membership_id IS NOT NULL`);
  // Last, since the map above is read from this column: every snapshot naming an assignment carries
  // that assignment's single anchor, so its new name is its own `assignment_id`.
  await knex.raw(
    `UPDATE plan_snapshots SET source_user_membership_id = assignment_id
      WHERE source_user_membership_id IS NOT NULL AND NOT (source_user_membership_id <=> assignment_id)`);

  await knex.raw('SET SESSION lock_wait_timeout = 30');
  try {
    await knex.raw('DROP TABLE plan_assignment_ids');
  } finally {
    await knex.raw('SET SESSION lock_wait_timeout = DEFAULT');
  }
};

exports.down = async (knex) => {
  if (await knex.schema.hasTable('plan_assignment_ids')) return;
  await knex.raw(`
    CREATE TABLE plan_assignment_ids (
      id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
      gym_id     CHAR(36)     NOT NULL,
      created_at DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
      PRIMARY KEY (id),
      KEY idx_pai_gym (gym_id),
      CONSTRAINT fk_pai_gym FOREIGN KEY (gym_id) REFERENCES gyms (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await knex.raw(
    `INSERT IGNORE INTO plan_assignment_ids (id, gym_id, created_at)
     SELECT source_user_membership_id, gym_id, MIN(created_at) FROM plan_snapshots
      WHERE source_user_membership_id IS NOT NULL GROUP BY source_user_membership_id, gym_id`);
  const [rows] = await knex.raw('SELECT COALESCE(MAX(id), 0) AS top FROM plan_snapshots');
  await knex.raw(`ALTER TABLE plan_assignment_ids AUTO_INCREMENT = ${Number(rows[0].top) + 1000}`);
};
