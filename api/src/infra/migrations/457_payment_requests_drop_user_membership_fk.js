/**
 * #2125 M6b-51d-7c-1 — `payment_requests.user_membership_id` stops pointing at `user_memberships`.
 *
 * From this release `insertAssignment()` only allocates the assignment's id in `plan_assignment_ids`
 * (migration 455) and writes no `user_memberships` row: the assignment is its plan snapshots (the
 * anchor holds its identity and lifecycle since M6b-51c-4 / M6b-51d-7b). A payment request for a new
 * assignment would therefore violate `payment_requests_user_membership_id_foreign`, the only foreign
 * key into the table (checked against `information_schema`: no view or trigger names it either).
 *
 * The column itself stays: it is the assignment's id, read by every reader through
 * `plan_snapshots.source_user_membership_id`, and `payment_requests.plan_assignment_id` (migration 431)
 * already carries the anchor. The constraint was `ON DELETE CASCADE`, but nothing deletes an
 * assignment that has payment requests (only an unpaid Draft is ever deleted), so no behaviour rides
 * on the cascade. Dropping a foreign key is a metadata change; the index it used stays.
 *
 * `down` puts the constraint back only while every request still names a `user_memberships` row;
 * after the new code has created an assignment that has none, it refuses rather than delete history.
 * Adding a foreign key rebuilds `payment_requests` (ALGORITHM=COPY), so `down` blocks its writes for
 * the copy. Apply `up` before the new API takes traffic (the normal migrate-then-deploy order).
 */

const FK = 'payment_requests_user_membership_id_foreign';

async function fkExists(knex) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'payment_requests'
        AND CONSTRAINT_NAME = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY'`, [FK]);
  return rows.length > 0;
}

exports.up = async (knex) => {
  if (await fkExists(knex)) {
    // Metadata only (INPLACE, no rebuild), but it still waits for a metadata lock on both tables;
    // fail fast rather than stall every payment query behind a long transaction.
    await knex.raw('SET SESSION lock_wait_timeout = 30');
    await knex.raw(`ALTER TABLE payment_requests DROP FOREIGN KEY ${FK}, ALGORITHM=INPLACE, LOCK=NONE`);
  }
};

exports.down = async (knex) => {
  if (await fkExists(knex)) return;
  const [orphans] = await knex.raw(
    `SELECT COUNT(*) AS n FROM payment_requests pr
      WHERE pr.user_membership_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM user_memberships um WHERE um.id = pr.user_membership_id)`);
  if (Number(orphans[0].n) > 0) {
    throw new Error(`migration 457 down: ${orphans[0].n} payment request(s) name an assignment with no user_memberships row`);
  }
  await knex.raw(
    `ALTER TABLE payment_requests ADD CONSTRAINT ${FK}
       FOREIGN KEY (user_membership_id) REFERENCES user_memberships (id) ON DELETE CASCADE`);
};
