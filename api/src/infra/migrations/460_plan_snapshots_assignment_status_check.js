/**
 * #2125 M7b — `plan_snapshots.assignment_status` gets the CHECK migration 453 promised.
 *
 * Since migration 453 the anchor snapshot of an assignment (`assignment_id = id`) carries the
 * assignment's lifecycle, and since migration 458 dropped `user_memberships` (and with it
 * `user_memberships_status_check`) it is the only record of the assignment's status. 453 left the
 * column unchecked "until the stage that makes these columns the source"; that stage has shipped, so
 * the value set is now enforced here as it is for `plan_snapshots.status` (`chk_plan_snapshots_status`):
 * the ten values of `ASSIGNMENT_STATUSES` (`api/src/domain/assignmentStatus.ts`), or NULL on every
 * snapshot that is not an anchor.
 *
 * It refuses, listing them, while a row holds a value outside the set: such a value can only have
 * come from outside the application and is for a person to correct, not for a migration to coerce.
 *
 * Adding a CHECK rebuilds `plan_snapshots` (ALGORITHM=COPY) and blocks its writes for the copy;
 * `lock_wait_timeout` bounds the wait for the metadata lock. `down` drops the constraint.
 */

const NAME = 'chk_plan_snapshots_assignment_status';
const STATUSES = [
  'in_cart', 'pending_payment', 'active', 'to_be_canceled', 'paused',
  'active_cancel_at_period_end', 'to_be_reactivated', 'cancelled', 'expired', 'superseded',
];
const LIST = STATUSES.map((s) => `'${s}'`).join(', ');

async function checkExists(knex) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'plan_snapshots' AND CONSTRAINT_NAME = ?`, [NAME]);
  return rows.length > 0;
}

exports.STATUSES = STATUSES;

exports.up = async (knex) => {
  if (await checkExists(knex)) return;
  const [bad] = await knex.raw(
    `SELECT id, gym_id, assignment_status FROM plan_snapshots
      WHERE assignment_status IS NOT NULL AND assignment_status NOT IN (${LIST}) ORDER BY id LIMIT 20`);
  if (bad.length > 0) {
    throw new Error(
      `migration 460: plan snapshot(s) with an unknown assignment_status: `
      + bad.map((r) => `#${r.id} (gym ${r.gym_id}, '${r.assignment_status}')`).join(', '));
  }
  await knex.raw('SET SESSION lock_wait_timeout = 30');
  try {
    await knex.raw(`ALTER TABLE plan_snapshots ADD CONSTRAINT ${NAME}
      CHECK (assignment_status IS NULL OR assignment_status IN (${LIST}))`);
  } finally {
    await knex.raw('SET SESSION lock_wait_timeout = DEFAULT');
  }
};

exports.down = async (knex) => {
  if (await checkExists(knex)) await knex.raw(`ALTER TABLE plan_snapshots DROP CHECK ${NAME}`);
};
