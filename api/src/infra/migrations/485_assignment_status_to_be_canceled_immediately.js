/**
 * #3358 stage 1 — a Membership Plan assignment may be stored as `to_be_canceled_immediately`: a plan
 * cancelling at its period end (`active_cancel_at_period_end`) that staff marked, in the owner's open
 * In Cart, to be cancelled today instead. It still entitles like the cancelling plan it is (now to
 * today) until the cart is committed (then `cancelled`); discarding the cart puts it back with its
 * previous end date. This migration widens the two CHECKs; no row moves.
 *
 *   plan_snapshots  chk_plan_snapshots_status             (status)
 *   plan_snapshots  chk_plan_snapshots_assignment_status  (assignment_status, NULL allowed)
 *
 * Safe to re-run. Both CHECKs are replaced in one ALTER, which rebuilds `plan_snapshots` once under ALGORITHM=COPY;
 * `lock_wait_timeout` bounds the wait for the metadata lock. Merge outside the nightly runs and the
 * 15-minute booking-reminder pass. `down` restores the previous lists and refuses to run while a row
 * holds the value.
 */

const BASE = [
  'in_cart', 'pending_payment', 'active', 'to_be_canceled', 'paused',
  'active_cancel_at_period_end', 'to_be_reactivated', 'cancelled', 'expired', 'superseded',
];
const WIDENED = [
  'in_cart', 'pending_payment', 'active', 'to_be_canceled', 'paused',
  'active_cancel_at_period_end', 'to_be_reactivated', 'to_be_canceled_immediately', 'cancelled', 'expired', 'superseded',
];
const CHECKS = ['chk_plan_snapshots_status', 'chk_plan_snapshots_assignment_status'];

const list = (values) => values.map((v) => `'${v}'`).join(', ');

/** Drops whichever of the two CHECKs exist and adds both back in one ALTER: one rebuild, no unchecked window. */
async function setChecks(knex, values) {
  const [existing] = await knex.raw(
    `SELECT CONSTRAINT_NAME AS name FROM information_schema.TABLE_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'plan_snapshots' AND CONSTRAINT_NAME IN (?, ?)`, CHECKS);
  const drops = existing.map((r) => `DROP CHECK ${r.name}`);
  await knex.raw('SET SESSION lock_wait_timeout = 30');
  try {
    await knex.raw(`ALTER TABLE plan_snapshots ${[
      ...drops,
      `ADD CONSTRAINT chk_plan_snapshots_status CHECK (status IN (${list(values)}))`,
      `ADD CONSTRAINT chk_plan_snapshots_assignment_status CHECK (assignment_status IS NULL OR assignment_status IN (${list(values)}))`,
    ].join(', ')}`);
  } finally {
    await knex.raw('SET SESSION lock_wait_timeout = DEFAULT');
  }
}

exports.up = async (knex) => {
  await setChecks(knex, WIDENED);
};

exports.down = async (knex) => {
  const [[row]] = await knex.raw(
    `SELECT COUNT(*) AS n FROM plan_snapshots
      WHERE status = 'to_be_canceled_immediately' OR assignment_status = 'to_be_canceled_immediately'`);
  if (Number(row.n) > 0) {
    throw new Error('plan_snapshots holds to_be_canceled_immediately rows; move them before reverting');
  }
  await setChecks(knex, BASE);
};
